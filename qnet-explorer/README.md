# QNet Explorer

Blockchain explorer and web interface for the QNet network.

## Features

- **Block and transaction viewer**
- **Account information display**
- **Network statistics and visualization**
- **Search functionality** for addresses, transactions, and blocks
- **Responsive design** for desktop and mobile

## Repository Structure

- `src/`: Application code
- `templates/`: HTML templates
- `static/`: CSS, JavaScript, and images
- `docker/`: Docker configuration for deployment

## Deployment

For Docker deployment:

```bash
docker build -f docker/Dockerfile.website -t qnet-explorer .
docker run -p 8080:8080 qnet-explorer