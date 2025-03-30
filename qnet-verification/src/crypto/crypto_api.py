#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: crypto_api.py
API endpoints for cryptographic operations.
"""

import logging
from flask import jsonify

def register_crypto_endpoints(app):
   """Register cryptographic API endpoints to a Flask app"""
   
   @app.route('/api/v1/crypto/algorithms', methods=['GET'])
   def get_algorithms():
       """Get information about available PQ algorithms"""
       try:
           # Hardcoded info about algorithms
           algorithms = {
               "Dilithium2": {
                   "available": "true",
                   "public_key_size": "1312",
                   "secret_key_size": "2528",
                   "signature_size": "2420"
               },
               "Dilithium3": {
                   "available": "false",
                   "public_key_size": "1952",
                   "secret_key_size": "4000",
                   "signature_size": "3293"
               },
               "SPHINCS+-SHAKE128s-simple": {
                   "available": "false",
                   "public_key_size": "32",
                   "secret_key_size": "64",
                   "signature_size": "7856"
               }
           }
           
           return jsonify({
               "algorithms": algorithms,
               "default": "Dilithium2",
               "implementation": "Python fallback"
           }), 200
       except Exception as e:
           logging.error(f"Error getting algorithm info: {e}")
           return jsonify({"error": str(e)}), 500