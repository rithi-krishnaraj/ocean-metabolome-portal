# Stage 1: Build the React/Vite application
FROM node:20.19-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the frontend source code
COPY . .

# Build the production assets
RUN npm run build

# Stage 2: Serve the built static assets with Nginx
FROM nginx:1.25-alpine

# Copy the built assets from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy our custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
