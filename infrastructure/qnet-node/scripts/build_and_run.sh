#!/bin/bash
# Enhanced build and run script for QNet with improved error handling

set -e

# ... (colors) ...

echo -e "${BLUE}=============================================${NC}"
echo -e "${BLUE}     QNet Node Build and Run Script         ${NC}"
echo -e "${BLUE}=============================================${NC}"

# Determine project root directory - OK
PROJECT_ROOT=$(pwd)
echo -e "${GREEN}Project root: $PROJECT_ROOT${NC}"

# Check docker and docker-compose - OK

# Create necessary directories - OK, creates top-level dirs
echo -e "${BLUE}Creating necessary directories...${NC}"
mkdir -p data blockchain_data keys snapshots logs config

# --- Section on Patches ---
# This should likely be removed or adapted. Patches are now handled during build
# inside the Dockerfile or install.sh, not typically in build_and_run.sh.
# If still needed here for some local setup, paths need correction.
# echo -e "${YELLOW}Checking for patches directory...${NC}"
# if [ ! -d "patches" ]; then
#     mkdir -p patches
# fi
# if [ ! -f "patches/crypto.rs" ] || [ ! -f "patches/merkle.rs" ]; then
#     echo -e "${YELLOW}Required patch files not found. Ensure they exist before running Docker build.${NC}"
# fi

# --- storage_factory.py ---
# This copy logic is likely unnecessary if the file is correctly placed in the source tree.
# echo -e "${YELLOW}Checking for storage_factory.py...${NC}"
# if [ -f "storage_factory.py" ]; then
#     mkdir -p src/storage # Should be qnet-core/src/storage ?
#     cp storage_factory.py src/storage/ # Correct path?
#     echo -e "${GREEN}Copied storage_factory.py to src/storage/${NC}"
# fi

# --- Nginx and SSL Setup --- OK (creates defaults if missing)

# Check if config exists, create default if not - OK (creates ./config/config.ini)

# Check for Docker Compose file - OK (uses docker_compose_adapted as template)
# Check for Dockerfile - OK (uses dockerfile_adapted as template)

# Build and start the containers - OK
echo -e "${BLUE}Building and starting QNet containers...${NC}"
docker-compose build || { echo -e "${RED}Error building containers.${NC}"; exit 1; }
docker-compose up -d || { echo -e "${RED}Error starting containers.${NC}"; exit 1; }

# Check container status - OK

# ... (final messages) ...