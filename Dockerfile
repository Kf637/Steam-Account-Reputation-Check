FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the app
COPY . .

# Expose port
EXPOSE 3100

# Start command
CMD ["node", "server.js"]
