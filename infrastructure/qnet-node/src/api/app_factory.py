# File: QNet-Project/qnet-node/src/api/app_factory.py
# -*- coding: utf-8 -*-
"""
Module: app_factory.py
Factory function to create and configure the Flask application for the QNet node API.
Handles middleware integration and blueprint registration.
"""
import os
import sys
import logging
import time
from flask import Flask, jsonify, request, g
from werkzeug.middleware.proxy_fix import ProxyFix

# --- Python Path Setup for app_factory ---
# This ensures that 'config_loader' and other 'src' level modules are found
# __file__ is .../qnet-node/src/api/app_factory.py
# os.path.dirname(__file__) is .../qnet-node/src/api
# os.path.join(os.path.dirname(__file__), '..') is .../qnet-node/src
SRC_DIR_FACTORY = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if SRC_DIR_FACTORY not in sys.path:
    sys.path.insert(0, SRC_DIR_FACTORY)

# For top-level modules like rate_limiter.py if it's in QNet-Project/
PROJECT_ROOT_FACTORY = os.path.abspath(os.path.join(SRC_DIR_FACTORY, '../..'))
if PROJECT_ROOT_FACTORY not in sys.path:
    sys.path.insert(0, PROJECT_ROOT_FACTORY)

# --- Configuration Loading ---
try:
    from config_loader import get_config, AppConfig # config_loader is in SRC_DIR_FACTORY
    app_config = get_config() # Initialize or get the singleton config instance
    if not app_config.parser.sections():
        logging.warning("app_factory.py: Config seems empty, attempting reload.")
        app_config.reload()
except ImportError:
    logging.basicConfig(level=logging.CRITICAL)
    logging.critical("app_factory.py: CRITICAL - Could not import 'config_loader'. Exiting.", exc_info=True)
    sys.exit(1)
except Exception as e_cfg_init:
    logging.basicConfig(level=logging.CRITICAL)
    logging.critical(f"app_factory.py: CRITICAL - Error initializing 'config_loader': {e_cfg_init}", exc_info=True)
    sys.exit(1)

# --- Logging Setup for app_factory module ---
factory_logger = logging.getLogger(__name__) # Use __name__ for module-specific logger
log_level_str_factory = app_config.get('System', 'log_level', fallback='INFO').upper()
numeric_level_factory = getattr(logging, log_level_str_factory, logging.INFO)
factory_logger.setLevel(numeric_level_factory)
# Add a handler if not configured by root logger already (e.g. if this module is imported before root config)
if not factory_logger.hasHandlers():
    ch_factory = logging.StreamHandler()
    formatter_factory = logging.Formatter('%(asctime)s [%(levelname)s] [%(name)s:%(lineno)d] %(message)s')
    ch_factory.setFormatter(formatter_factory)
    factory_logger.addHandler(ch_factory)


def create_app(): # This is THE factory now
    """Creates and configures the Flask application."""
    factory_logger.info("Creating Flask app instance from app_factory...")
    # Using "qnet_node_api_service" as the import_name for the Flask app.
    # This helps Flask find templates/static if your app is structured as a package.
    # If your templates/static are at the same level as this api directory,
    # or if you use blueprint-specific template folders, this is fine.
    app = Flask("qnet_node_api_service")

    # Load main config into Flask app config
    app.config['SECRET_KEY'] = app_config.get('Security', 'flask_secret_key', fallback=os.urandom(32).hex())
    app.config['DEBUG'] = os.environ.get('FLASK_ENV', 'production').lower() == 'development'
    
    # Configure Flask's own logger
    # Flask's logger (app.logger) will be used by Flask and extensions.
    # It's good practice to set its level according to your config.
    gunicorn_logger = logging.getLogger('gunicorn.error') # Example for Gunicorn integration
    app.logger.handlers.extend(gunicorn_logger.handlers)
    app.logger.setLevel(numeric_level_factory) # Use same level as module loggers

    if app_config.getboolean('Network', 'behind_proxy', fallback=False):
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
        app.logger.info("ProxyFix enabled for Flask app.")

    # --- Middleware Setup ---
    try:
        from rate_limiter import apply_rate_limiting # Expected in PROJECT_ROOT_FACTORY
        apply_rate_limiting(app)
        app.logger.info("Rate limiting middleware applied.")
    except ImportError:
        app.logger.warning("rate_limiter.py not found or failed to import. Rate limiting disabled.")
    except Exception as e:
        app.logger.error(f"Error applying rate limiting middleware: {e}")

    try:
        from node.monitoring import MetricsMiddleware # Expected in qnet-node.src.node.monitoring
        MetricsMiddleware(app)
        app.logger.info("Monitoring middleware applied.")
    except ImportError:
        app.logger.warning("Monitoring middleware (node.monitoring) not found or failed to import.")
    except Exception as e:
        app.logger.error(f"Error applying monitoring middleware: {e}")

    @app.after_request
    def add_security_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['X-XSS-Protection'] = '1; mode=block'
        return response

    @app.before_request
    def before_request_timing():
        g.request_start_time = time.time()

    @app.after_request
    def after_request_timing(response):
        if hasattr(g, 'request_start_time'):
            duration = (time.time() - g.request_start_time) * 1000
            app.logger.debug(
                f"Request {request.path} from {request.remote_addr} took {duration:.2f}ms - Status {response.status_code}"
            )
            response.headers['X-Response-Time-ms'] = f"{duration:.2f}"
        return response

    # --- Blueprint Registration ---
    # Since app_factory.py is inside the 'api' package,
    # we use relative imports for other modules in the same 'api' package.
    factory_logger.info("Registering blueprints...")
    try:
        from .main_api import main_bp 
        app.register_blueprint(main_bp, url_prefix='/api/v1')
        app.logger.info("Registered main_api blueprint under /api/v1")
    except ImportError as e: app.logger.error(f"Failed to import or register main_api: {e}", exc_info=app.debug)

    try:
        from .admin_api import admin_bp
        app.register_blueprint(admin_bp, url_prefix='/api/v1/admin')
        app.logger.info("Registered admin_api blueprint under /api/v1/admin")
    except ImportError as e: app.logger.warning(f"Admin_api blueprint not found: {e}", exc_info=app.debug)

    try:
        from .activation_bridge_api import activation_bp
        app.register_blueprint(activation_bp, url_prefix='/api/v1/activation')
        app.logger.info("Registered activation_bridge_api blueprint under /api/v1/activation")
    except ImportError as e: app.logger.warning(f"Activation_bridge_api blueprint not found: {e}", exc_info=app.debug)

    try:
        from .reward_claim_api import reward_bp
        app.register_blueprint(reward_bp, url_prefix='/api/v1/rewards')
        app.logger.info("Registered reward_claim_api blueprint under /api/v1/rewards")
    except ImportError as e: app.logger.warning(f"Reward_claim_api blueprint not found: {e}", exc_info=app.debug)

    try:
        from .consensus_api import consensus_bp
        app.register_blueprint(consensus_bp, url_prefix='/api/v1/consensus')
        app.logger.info("Registered consensus_api blueprint under /api/v1/consensus")
    except ImportError as e: app.logger.warning(f"Consensus_api blueprint not found: {e}", exc_info=app.debug)
    
    try:
        from .mobile_api import MobileAPI 
        MobileAPI(app, config=app_config)
        app.logger.info("MobileAPI initialized and its blueprint registered.")
    except ImportError as e:
        app.logger.warning(f"Mobile_api class not found/configured: {e}", exc_info=app.debug)

    # --- Basic Root Endpoint ---
    @app.route('/')
    def root():
        return jsonify({
            "message": "Welcome to QNet Node API Service (created by app_factory)",
            "version": app_config.get('App', 'version', fallback="0.1.0"),
            "status": "running"
        })

    # --- Global Error Handlers ---
    # (Keep your existing error handlers: handle_exception, handle_404, handle_400, etc.)
    @app.errorhandler(Exception)
    def handle_exception(e):
        app.logger.exception(f"Unhandled exception: {e}")
        error_message = "Internal Server Error"
        if app.debug: error_message = str(e)
        return jsonify(error=error_message), 500

    @app.errorhandler(404)
    def handle_404(e):
         return jsonify(error="Not Found", message=f"The requested URL {request.path} was not found."), 404

    @app.errorhandler(400)
    def handle_400(e):
        description = getattr(e, 'description', 'Invalid request parameters or malformed request.')
        return jsonify(error="Bad Request", message=description), 400

    @app.errorhandler(401)
    def handle_401(e):
        description = getattr(e, 'description', 'Authentication required or invalid credentials.')
        return jsonify(error="Unauthorized", message=description), 401
    
    @app.errorhandler(403)
    def handle_403(e):
        description = getattr(e, 'description', 'Permission denied to access this resource.')
        return jsonify(error="Forbidden", message=description), 403

    @app.errorhandler(429)
    def handle_429(e):
        description = getattr(e, 'description', 'Rate limit exceeded. Please try again later.')
        response = jsonify(error="Rate Limit Exceeded", message=description)
        response.headers['Retry-After'] = getattr(e, 'retry_after', '60') 
        return response, 429

    factory_logger.info("Flask app instance fully configured by app_factory.")
    return app