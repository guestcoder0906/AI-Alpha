FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the files
COPY . .

# Build the Next.js app
RUN npm run build

# Next.js binds to port 3000 by default
EXPOSE 3000

# Start server
CMD ["npm", "start"]
