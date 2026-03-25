import ee from '@google/earthengine';

let eeInitialized = false;
let initPromise: Promise<void> | null = null;

export async function initEarthEngine(): Promise<void> {
  if (eeInitialized) return;
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    try {
      if (!process.env.EE_PRIVATE_KEY_JSON) {
        throw new Error("Missing EE_PRIVATE_KEY_JSON environment variable.");
      }
      const privateKey = JSON.parse(process.env.EE_PRIVATE_KEY_JSON);

      ee.data.authenticateViaPrivateKey(
        privateKey,
        () => {
          ee.initialize(
            null,
            null,
            () => {
              console.log('Earth Engine initialized successfully.');
              eeInitialized = true;
              resolve();
            },
            (e: any) => {
              console.error('Earth Engine initialization error:', e);
              reject(e);
            }
          );
        },
        (e: any) => {
          console.error('Earth Engine authentication error:', e);
          reject(e);
        }
      );
    } catch (error) {
      console.error('Failed to read EE private key:', error);
      reject(error);
    }
  });

  return initPromise;
}

/**
 * Execute an Earth Engine task. Supports:
 * - generate_dem: Global SRTM DEM visualization
 * - get_satellite_image: Retrieve Landsat/Sentinel imagery for a region
 * - run_custom_script: Execute arbitrary EE JavaScript code (for AI-generated scripts)
 */
export async function executeEarthEngineTask(taskType: string, params: any): Promise<any> {
  await initEarthEngine();

  if (taskType === 'generate_dem') {
    const dem = ee.Image('USGS/SRTMGL1_003');
    const visParams = {
      min: 0,
      max: 4000,
      palette: ['006633', 'E5FFCC', '662A00', 'D8D8D8', 'F5F5F5']
    };

    return new Promise((resolve, reject) => {
      dem.getMap(visParams, (map: any, err: any) => {
        if (err) reject(err);
        else resolve({ urlFormat: map.urlFormat, metadata: 'Global SRTM Digital Elevation Model' });
      });
    });
  }

  if (taskType === 'get_satellite_image') {
    // Retrieve satellite imagery for a given region and date range
    const { lon, lat, startDate, endDate, dataset } = params;
    const point = ee.Geometry.Point([parseFloat(lon || 0), parseFloat(lat || 0)]);
    const buffer = point.buffer(50000); // 50km radius

    let collection;
    const dsId = (dataset || 'landsat8').toLowerCase();

    if (dsId.includes('sentinel')) {
      collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED');
    } else {
      collection = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2');
    }

    const filtered = collection
      .filterBounds(buffer)
      .filterDate(startDate || '2023-01-01', endDate || '2024-01-01')
      .sort('CLOUDY_PIXEL_PERCENTAGE', true)
      .first();

    const visParams = dsId.includes('sentinel')
      ? { bands: ['B4', 'B3', 'B2'], min: 0, max: 3000 }
      : { bands: ['SR_B4', 'SR_B3', 'SR_B2'], min: 5000, max: 15000 };

    return new Promise((resolve, reject) => {
      filtered.getMap(visParams, (map: any, err: any) => {
        if (err) reject(new Error("Satellite image retrieval failed: " + err));
        else resolve({
          urlFormat: map.urlFormat,
          metadata: `Satellite image near [${lat}, ${lon}] from ${startDate || '2023'} to ${endDate || '2024'} using ${dsId}`
        });
      });
    });
  }

  if (taskType === 'run_custom_script') {
    const script = params.script;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const executable = new AsyncFunction('ee', `
        ${script}
      `);
      return await executable(ee);
    } catch(e: any) {
      throw new Error("Script Execution Error: " + e.message);
    }
  }

  throw new Error(`Unknown EE taskType: ${taskType}. Supported: generate_dem, get_satellite_image, run_custom_script`);
}
