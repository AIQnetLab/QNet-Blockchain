#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: documentation.py
Documentation generator for QNet
"""

import os
import json
import logging
import time
import markdown
import re
from typing import Dict, Any, List, Optional, Union, Set, Tuple
from flask import Flask, Blueprint, render_template, request, jsonify

class DocumentationGenerator:
    """
    Documentation generator for QNet.
    Provides API documentation, user guides, and technical specifications.
    """
    
    def __init__(self, app: Flask, config=None):
        """
        Initialize the documentation generator.
        
        Args:
            app: Flask application instance
            config: Configuration object or dictionary
        """
        # Default configuration
        self.config = {
            'docs_enabled': os.environ.get('QNET_DOCS_ENABLED', 'true').lower() == 'true',
            'docs_prefix': os.environ.get('QNET_DOCS_PREFIX', '/docs'),
            'api_docs_enabled': os.environ.get('QNET_API_DOCS_ENABLED', 'true').lower() == 'true',
            'user_guides_enabled': os.environ.get('QNET_USER_GUIDES_ENABLED', 'true').lower() == 'true',
            'docs_dir': os.environ.get('QNET_DOCS_DIR', './docs'),
            'api_version': os.environ.get('QNET_API_VERSION', 'v1'),
        }
        
        # Override with provided config if available
        if config:
            if hasattr(config, '__getitem__'):
                for key, value in self.config.items():
                    if key in config:
                        self.config[key] = config[key]
            else:
                for key in self.config.keys():
                    if hasattr(config, key):
                        self.config[key] = getattr(config, key)
        
        # Store Flask app reference
        self.app = app
        
        # Create blueprint
        self.blueprint = Blueprint('docs', __name__)
        
        # Documentation data
        self.api_endpoints = []
        self.user_guides = []
        self.technical_docs = []
        
        # Load documentation
        self._load_documentation()
        
        # Register routes if docs are enabled
        if self.config['docs_enabled']:
            self._register_routes()
            
            # Register blueprint with app
            self.app.register_blueprint(self.blueprint, url_prefix=self.config['docs_prefix'])
            
            logging.info(f"Documentation initialized at {self.config['docs_prefix']}")
        else:
            logging.info("Documentation disabled")
    
    def _register_routes(self):
        """Register documentation routes with blueprint."""
        
        # Main documentation index
        @self.blueprint.route('/')
        def docs_index():
            return render_template('docs/index.html',
                                  api_enabled=self.config['api_docs_enabled'],
                                  guides_enabled=self.config['user_guides_enabled'])
        
        # API documentation
        if self.config['api_docs_enabled']:
            @self.blueprint.route('/api')
            def api_docs():
                return render_template('docs/api_index.html',
                                      api_endpoints=self.api_endpoints,
                                      api_version=self.config['api_version'])
                                      
            @self.blueprint.route('/api/<string:endpoint>')
            def api_endpoint_docs(endpoint):
                # Find the specified endpoint
                for ep in self.api_endpoints:
                    if ep['endpoint'] == endpoint:
                        return render_template('docs/api_endpoint.html',
                                              endpoint=ep,
                                              api_version=self.config['api_version'])
                
                # Endpoint not found
                return render_template('docs/not_found.html',
                                      message=f"API endpoint '{endpoint}' not found")
        
        # User guides
        if self.config['user_guides_enabled']:
            @self.blueprint.route('/guides')
            def user_guides():
                return render_template('docs/guides_index.html',
                                      guides=self.user_guides)
                                      
            @self.blueprint.route('/guides/<string:guide_id>')
            def user_guide(guide_id):
                # Find the specified guide
                for guide in self.user_guides:
                    if guide['id'] == guide_id:
                        # Render guide content
                        content_html = markdown.markdown(guide['content'])
                        
                        return render_template('docs/guide.html',
                                              guide=guide,
                                              content_html=content_html)
                
                # Guide not found
                return render_template('docs/not_found.html',
                                      message=f"User guide '{guide_id}' not found")
        
        # Technical documentation
        @self.blueprint.route('/technical')
        def technical_docs():
            return render_template('docs/technical_index.html',
                                  docs=self.technical_docs)
                                  
        @self.blueprint.route('/technical/<string:doc_id>')
        def technical_doc(doc_id):
            # Find the specified technical document
            for doc in self.technical_docs:
                if doc['id'] == doc_id:
                    # Render document content
                    content_html = markdown.markdown(doc['content'])
                    
                    return render_template('docs/technical.html',
                                          doc=doc,
                                          content_html=content_html)
            
            # Document not found
            return render_template('docs/not_found.html',
                                  message=f"Technical document '{doc_id}' not found")
        
        # JSON API for documentation data
        @self.blueprint.route('/api.json')
        def api_json():
            return jsonify({
                'api_version': self.config['api_version'],
                'endpoints': self.api_endpoints
            })
            
        @self.blueprint.route('/guides.json')
        def guides_json():
            return jsonify({
                'guides': self.user_guides
            })
            
        @self.blueprint.route('/technical.json')
        def technical_json():
            return jsonify({
                'technical_docs': self.technical_docs
            })
    
    def _load_documentation(self):
        """Load documentation from files."""
        docs_dir = self.config['docs_dir']
        
        # Load API documentation
        if self.config['api_docs_enabled']:
            api_dir = os.path.join(docs_dir, 'api')
            self._load_api_docs(api_dir)
        
        # Load user guides
        if self.config['user_guides_enabled']:
            guides_dir = os.path.join(docs_dir, 'guides')
            self._load_user_guides(guides_dir)
        
        # Load technical documentation
        technical_dir = os.path.join(docs_dir, 'technical')
        self._load_technical_docs(technical_dir)
    
    def _load_api_docs(self, api_dir: str):
        """
        Load API documentation from files.
        
        Args:
            api_dir: Directory containing API documentation
        """
        if not os.path.exists(api_dir):
            logging.warning(f"API documentation directory not found: {api_dir}")
            return
            
        # Look for endpoints JSON file or individual endpoint files
        endpoints_file = os.path.join(api_dir, 'endpoints.json')
        if os.path.exists(endpoints_file):
            # Load from JSON file
            try:
                with open(endpoints_file, 'r') as f:
                    self.api_endpoints = json.load(f)
                    
                logging.info(f"Loaded {len(self.api_endpoints)} API endpoints from {endpoints_file}")
            except Exception as e:
                logging.error(f"Error loading API endpoints: {e}")
        else:
            # Look for individual endpoint files
            endpoints = []
            
            # List all JSON files in the directory
            for filename in os.listdir(api_dir):
                if filename.endswith('.json'):
                    file_path = os.path.join(api_dir, filename)
                    
                    try:
                        with open(file_path, 'r') as f:
                            endpoint = json.load(f)
                            endpoints.append(endpoint)
                    except Exception as e:
                        logging.error(f"Error loading API endpoint from {file_path}: {e}")
            
            self.api_endpoints = endpoints
            logging.info(f"Loaded {len(self.api_endpoints)} API endpoints from individual files")
    
    def _load_user_guides(self, guides_dir: str):
        """
        Load user guides from files.
        
        Args:
            guides_dir: Directory containing user guides
        """
        if not os.path.exists(guides_dir):
            logging.warning(f"User guides directory not found: {guides_dir}")
            return
            
        # Look for index JSON file or individual guide files
        index_file = os.path.join(guides_dir, 'index.json')
        if os.path.exists(index_file):
            # Load index file
            try:
                with open(index_file, 'r') as f:
                    guides_index = json.load(f)
                    
                # Load each guide
                guides = []
                for guide_info in guides_index:
                    guide_id = guide_info['id']
                    guide_file = os.path.join(guides_dir, f"{guide_id}.md")
                    
                    if os.path.exists(guide_file):
                        with open(guide_file, 'r') as f:
                            content = f.read()
                            
                        guide = guide_info.copy()
                        guide['content'] = content
                        guides.append(guide)
                    else:
                        logging.warning(f"Guide file not found: {guide_file}")
                
                self.user_guides = guides
                logging.info(f"Loaded {len(self.user_guides)} user guides from index")
            except Exception as e:
                logging.error(f"Error loading user guides: {e}")
        else:
            # Look for individual Markdown files
            guides = []
            
            # List all Markdown files in the directory
            for filename in os.listdir(guides_dir):
                if filename.endswith('.md'):
                    file_path = os.path.join(guides_dir, filename)
                    
                    try:
                        with open(file_path, 'r') as f:
                            content = f.read()
                            
                        # Extract metadata from the first few lines
                        lines = content.split('\n')
                        title = lines[0].lstrip('#').strip() if lines and lines[0].startswith('#') else filename
                        
                        # Look for description in the first few lines
                        description = ""
                        for line in lines[1:5]:
                            if line and not line.startswith('#'):
                                description = line.strip()
                                break
                                
                        guide_id = filename[:-3]  # Remove .md extension
                        
                        guide = {
                            'id': guide_id,
                            'title': title,
                            'description': description,
                            'content': content
                        }
                        
                        guides.append(guide)
                    except Exception as e:
                        logging.error(f"Error loading user guide from {file_path}: {e}")
            
            self.user_guides = guides
            logging.info(f"Loaded {len(self.user_guides)} user guides from individual files")
    
    def _load_technical_docs(self, technical_dir: str):
        """
        Load technical documentation from files.
        
        Args:
            technical_dir: Directory containing technical documentation
        """
        if not os.path.exists(technical_dir):
            logging.warning(f"Technical documentation directory not found: {technical_dir}")
            return
            
        # Look for index JSON file or individual doc files
        index_file = os.path.join(technical_dir, 'index.json')
        if os.path.exists(index_file):
            # Load index file
            try:
                with open(index_file, 'r') as f:
                    docs_index = json.load(f)
                    
                # Load each document
                docs = []
                for doc_info in docs_index:
                    doc_id = doc_info['id']
                    doc_file = os.path.join(technical_dir, f"{doc_id}.md")
                    
                    if os.path.exists(doc_file):
                        with open(doc_file, 'r') as f:
                            content = f.read()
                            
                        doc = doc_info.copy()
                        doc['content'] = content
                        docs.append(doc)
                    else:
                        logging.warning(f"Technical document file not found: {doc_file}")
                
                self.technical_docs = docs
                logging.info(f"Loaded {len(self.technical_docs)} technical documents from index")
            except Exception as e:
                logging.error(f"Error loading technical documents: {e}")
        else:
            # Look for individual Markdown files
            docs = []
            
            # List all Markdown files in the directory
            for filename in os.listdir(technical_dir):
                if filename.endswith('.md'):
                    file_path = os.path.join(technical_dir, filename)
                    
                    try:
                        with open(file_path, 'r') as f:
                            content = f.read()
                            
                        # Extract metadata from the first few lines
                        lines = content.split('\n')
                        title = lines[0].lstrip('#').strip() if lines and lines[0].startswith('#') else filename
                        
                        # Look for description in the first few lines
                        description = ""
                        for line in lines[1:5]:
                            if line and not line.startswith('#'):
                                description = line.strip()
                                break
                                
                        doc_id = filename[:-3]  # Remove .md extension
                        
                        doc = {
                            'id': doc_id,
                            'title': title,
                            'description': description,
                            'content': content
                        }
                        
                        docs.append(doc)
                    except Exception as e:
                        logging.error(f"Error loading technical document from {file_path}: {e}")
            
            self.technical_docs = docs
            logging.info(f"Loaded {len(self.technical_docs)} technical documents from individual files")
    
    def generate_api_documentation(self):
        """Generate API documentation based on application routes."""
        if not self.config['api_docs_enabled']:
            return
            
        # Get all routes from the application
        api_endpoints = []
        
        # Iterate over all routes
        for rule in self.app.url_map.iter_rules():
            # Skip non-API routes and documentation routes
            if not str(rule).startswith('/api') or str(rule).startswith(self.config['docs_prefix']):
                continue
                
            # Get endpoint information
            endpoint = {
                'endpoint': str(rule),
                'methods': list(rule.methods - {'HEAD', 'OPTIONS'}),
                'description': self._extract_endpoint_description(rule.endpoint),
                'parameters': self._extract_endpoint_parameters(rule.endpoint),
                'responses': self._extract_endpoint_responses(rule.endpoint)
            }
            
            api_endpoints.append(endpoint)
        
        self.api_endpoints = api_endpoints
        logging.info(f"Generated documentation for {len(self.api_endpoints)} API endpoints")
    
    def _extract_endpoint_description(self, endpoint_name: str) -> str:
        """
        Extract description from endpoint function docstring.
        
        Args:
            endpoint_name: Endpoint function name
            
        Returns:
            Description string
        """
        # Get view function
        view_func = self.app.view_functions.get(endpoint_name)
        if not view_func:
            return ""
            
        # Get docstring
        docstring = view_func.__doc__
        if not docstring:
            return ""
            
        # Extract first paragraph
        lines = docstring.strip().split('\n')
        description = lines[0].strip()
        
        return description
    
    def _extract_endpoint_parameters(self, endpoint_name: str) -> List[Dict[str, str]]:
        """
        Extract parameters from endpoint function docstring.
        
        Args:
            endpoint_name: Endpoint function name
            
        Returns:
            List of parameter dictionaries
        """
        # Get view function
        view_func = self.app.view_functions.get(endpoint_name)
        if not view_func:
            return []
            
        # Get docstring
        docstring = view_func.__doc__
        if not docstring:
            return []
            
        # Extract parameters section
        parameters = []
        in_params_section = False
        
        for line in docstring.strip().split('\n'):
            line = line.strip()
            
            if in_params_section:
                # Check if we've reached the end of the parameters section
                if line.startswith('Returns:') or not line:
                    in_params_section = False
                    continue
                    
                # Parse parameter
                match = re.match(r'(\w+)\s*\((\w+)\):\s*(.+)', line)
                if match:
                    param_name, param_type, param_desc = match.groups()
                    parameters.append({
                        'name': param_name,
                        'type': param_type,
                        'description': param_desc
                    })
            elif line.startswith('Args:') or line.startswith('Parameters:'):
                in_params_section = True
        
        return parameters
    
    def _extract_endpoint_responses(self, endpoint_name: str) -> Dict[str, str]:
        """
        Extract response information from endpoint function docstring.
        
        Args:
            endpoint_name: Endpoint function name
            
        Returns:
            Dictionary of response codes and descriptions
        """
        # Get view function
        view_func = self.app.view_functions.get(endpoint_name)
        if not view_func:
            return {}
            
        # Get docstring
        docstring = view_func.__doc__
        if not docstring:
            return {}
            
        # Extract responses section
        responses = {}
        in_responses_section = False
        
        for line in docstring.strip().split('\n'):
            line = line.strip()
            
            if in_responses_section:
                # Check if we've reached the end of the responses section
                if not line:
                    in_responses_section = False
                    continue
                    
                # Parse response
                match = re.match(r'(\d+):\s*(.+)', line)
                if match:
                    status_code, desc = match.groups()
                    responses[status_code] = desc
            elif line.startswith('Responses:'):
                in_responses_section = True
        
        # Default responses if none found
        if not responses:
            responses = {
                '200': 'Successful response',
                '400': 'Bad request',
                '500': 'Internal server error'
            }
        
        return responses

# Helper function to initialize the documentation generator
def init_documentation(app: Flask, config=None) -> DocumentationGenerator:
    """
    Initialize the documentation generator with a Flask app.
    
    Args:
        app: Flask application instance
        config: Optional configuration
        
    Returns:
        DocumentationGenerator instance
    """
    return DocumentationGenerator(app, config)

# Sample user guide content (for testing)
SAMPLE_USER_GUIDE = """
# Getting Started with QNet

This guide will help you set up and run a QNet node on your system.

## Prerequisites

Before you begin, make sure you have the following:

- Python 3.10 or higher
- Docker (optional but recommended)
- At least 2GB of RAM and 10GB of storage
- A Solana wallet with QnetAccess tokens (for mainnet)

## Installation

### Using Docker (Recommended)

The easiest way to run QNet is using Docker:

```bash
# Pull the latest image
docker pull qnetblockchain/qnet-node:latest

# Create directories for data
mkdir -p qnet/data qnet/keys qnet/snapshots

# Run the container
docker run -d \\
  --name qnet-node \\
  -p 127.0.0.1:8000:8000 \\
  -p 127.0.0.1:8080:8080 \\
  -v ./qnet/data:/app/blockchain_data \\
  -v ./qnet/keys:/app/keys \\
  -v ./qnet/snapshots:/app/snapshots \\
  qnetblockchain/qnet-node:latest
```

### Manual Installation

If you prefer to run without Docker:

1. Clone the repository:
   ```bash
   git clone https://gitlab.com/qnet-blockchain/qnet-node.git
   cd qnet-node
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Build Rust components:
   ```bash
   ./build_rust.sh
   ```

4. Start the node:
   ```bash
   ./start.sh
   ```

## Configuration

The node can be configured using environment variables or a configuration file.

### Environment Variables

- `QNET_NETWORK`: Network to connect to (`testnet` or `mainnet`)
- `QNET_EXTERNAL_IP`: External IP address for the node (use `auto` for automatic detection)
- `QNET_PORT`: Port for the node API (default: 8000)
- `QNET_DASHBOARD_PORT`: Port for the dashboard (default: 8080)

### Configuration File

Create a `config.ini` file in the root directory with the following content:

```ini
[network]
network = testnet
external_ip = auto
port = 8000
dashboard_port = 8080

[storage]
storage_type = rocksdb
data_dir = /app/blockchain_data

[consensus]
commit_window_seconds = 60
reveal_window_seconds = 30
```

## Accessing the Dashboard

Once your node is running, you can access the dashboard at:

http://localhost:8080

The dashboard provides information about your node's status, the blockchain, and network peers.

## Next Steps

- [Connect Your Wallet](wallet-connection.md)
- [Activate Your Node](node-activation.md)
- [Monitor Node Performance](node-monitoring.md)
"""

# Sample technical document content (for testing)
SAMPLE_TECHNICAL_DOC = """
# QNet Consensus Protocol

This document provides a technical overview of the QNet consensus protocol, focusing on its commit-reveal mechanism.

## Overview

QNet uses a commit-reveal consensus mechanism to prevent front-running and Sybil attacks while maintaining security and scalability. The consensus process occurs in two phases:

1. **Commit Phase**: Nodes commit to a value without revealing it
2. **Reveal Phase**: Nodes reveal their committed values

This approach ensures that nodes cannot change their decisions based on the commitments of others.

## Commit Phase

During the commit phase, each node:

1. Generates a random value
2. Creates a commitment by hashing the value with a nonce
3. Signs the commitment with its private key
4. Broadcasts the commitment to the network

A commitment is structured as follows:

```json
{
  "round": 123,
  "proposer": "node_id",
  "hash": "commit_hash",
  "signature": "signature",
  "timestamp": 1645678901
}
```

The commit hash is computed as:
```
commit_hash = SHA256(value + nonce + round + node_id)
```

## Reveal Phase

Once a sufficient number of commitments have been received, the network transitions to the reveal phase. During this phase, each node:

1. Reveals its previously committed value and the nonce used
2. Broadcasts this information to the network

The network verifies each reveal by:
1. Computing the commit hash using the revealed value and nonce
2. Comparing it with the previously submitted commitment

## Winner Determination

Once the reveal phase is complete, the protocol deterministically selects a winner:

1. All revealed values are combined (concatenated)
2. The combined value is hashed
3. The resulting hash is normalized to a value between 0 and 1
4. This value is subject to a difficulty threshold
5. If the value is below the threshold, a winner is selected based on it
6. If not, no winner is selected for this round

## Sybil Resistance

The protocol prevents Sybil attacks by:

1. Requiring nodes to have a minimum number of QnetAccess tokens
2. Enforcing one-node-per-wallet policy
3. Using token ownership verification through Solana blockchain

## Performance Considerations

- Target block time: 60 seconds
- Commit phase: 60 seconds (configurable)
- Reveal phase: 30 seconds (configurable)
- Difficulty adjustment: Every 10 blocks

The difficulty is adjusted to maintain a consistent average block time of 60 seconds. The adjustment formula is:
```
new_difficulty = current_difficulty * (target_time / actual_time)
```

## Fallback Mechanism

If no winner is determined (due to difficulty threshold or insufficient reveals), the round is considered failed and a new round begins.

## Security Analysis

The commit-reveal mechanism provides the following security properties:

1. **Resistance to front-running**: Nodes cannot change their values based on others' commitments
2. **Unpredictability**: The winner cannot be determined until after the reveal phase
3. **Fairness**: Every node has an equal chance of winning proportional to their commitment
4. **Non-manipulability**: Nodes cannot manipulate the outcome after committing

## Implementation Notes

The consensus implementation is divided into the following components:

- `consensus.py`: Core consensus logic
- `crypto_bindings.py`: Cryptographic operations
- `validation_decorators.py`: Validation functions

For more details, refer to the source code and implementation notes.
"""