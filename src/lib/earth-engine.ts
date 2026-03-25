import ee from '@google/earthengine';
import fs from 'fs';
import path from 'path';

let eeInitialized = false;
let initPromise: Promise<void> | null = null;

export async function initEarthEngine(): Promise<void> {
  if (eeInitialized) return;
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    try {
      const keyPath = process.env.EE_PRIVATE_KEY_PATH || 'gen-lang-client-0982648087-9a55b6b1926a.json';
      const absoluteKeyPath = path.resolve(process.cwd(), keyPath);
      
      const privateKey = JSON.parse(fs.readFileSync(absoluteKeyPath, 'utf8'));

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
  
  if (taskType === 'run_custom_script') {
    // A secure-ish way to execute custom EE scripts safely inside node
    // To allow the LLM to generate custom EE code for mapping
    const script = params.script;
    try {
      // Evaluate custom script that returns a serializable Promise or output
      // Note: In a production environment, you should use isolation/sandbox.
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const executable = new AsyncFunction('ee', `
        ${script}
      `);
      return await executable(ee);
    } catch(e: any) {
      throw new Error("Script Execution Error: " + e.message);
    }
  }

  throw new Error(`Unknown EE taskType: ${taskType}`);
}
