"""
Pricing API - Dynamic pricing for node activation
Integrates 1DEV burn model and QNC pricing
"""

from flask import Blueprint, jsonify, request, current_app
from typing import Dict, Optional
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from economics.onedev_burn_model import OneDEVBurnCalculator, NodeType, BurnProgressTracker
from economics.dynamic_pricing import DynamicPricingCalculator
from economics.transition_protection import TransitionProtectionManager

pricing_bp = Blueprint('pricing', __name__)

# Global instances
onedev_calculator = OneDEVBurnCalculator()
qnc_calculator = DynamicPricingCalculator()
transition_manager = TransitionProtectionManager()
burn_tracker = BurnProgressTracker()

# Import burn state tracker
try:
    from economics.burn_state_tracker import BurnStateTracker
    state_tracker = BurnStateTracker()
except ImportError:
    state_tracker = None
    current_app.logger.warning("BurnStateTracker not available, using mock data")

def get_current_burn_stats() -> Dict:
    """Get current 1DEV burn statistics from blockchain"""
    if state_tracker:
        # Get real data from blockchain
        return state_tracker.get_current_burn_state()
    else:
        # Fallback to mock data
        return {
            "total_burned": 250_000_000,  # 25% burned (mock)
            "burn_rate_per_day": 1_000_000,  # 1M 1DEV/day (mock)
            "days_since_launch": 180,  # 6 months (mock)
            "data_source": "mock"
        }

def get_active_nodes_count() -> Dict[NodeType, int]:
    """Get current active node counts from network"""
    # TODO: Integrate with actual network data
    # For now, return mock data
    return {
        NodeType.LIGHT: 7000,
        NodeType.FULL: 2500,
        NodeType.SUPER: 500
    }

@pricing_bp.route('/current_prices', methods=['GET'])
def get_current_prices():
    """Get current activation prices for all node types"""
    try:
        # Get burn statistics
        burn_stats = get_current_burn_stats()
        total_burned = burn_stats["total_burned"]
        
        # Get 1DEV burn prices
        onedev_schedule = onedev_calculator.get_burn_schedule(total_burned)
        
        # Check if we've transitioned to QNC
        if onedev_schedule["light"]["transition_complete"]:
            # Get QNC prices based on active nodes
            active_nodes = get_active_nodes_count()
            qnc_prices = qnc_calculator.get_price_schedule(active_nodes)
            
            prices = {
                "token": "QNC",
                "prices": {
                    "light": qnc_prices[NodeType.LIGHT],
                    "full": qnc_prices[NodeType.FULL],
                    "super": qnc_prices[NodeType.SUPER]
                },
                "transition_complete": True
            }
        else:
            # Still in 1DEV phase
            prices = {
                "token": "1DEV",
                "prices": {
                    "light": onedev_schedule["light"]["amount"],
                    "full": onedev_schedule["full"]["amount"],
                    "super": onedev_schedule["super"]["amount"]
                },
                "transition_complete": False,
                "burn_percentage": onedev_schedule["light"]["burn_percentage"]
            }
        
        # Add transition protection if applicable
        if 0.85 <= burn_stats["total_burned"] / 1_000_000_000 < 0.9:
            prices["transition_protection_active"] = True
        
        return jsonify({
            "success": True,
            "data": prices,
            "timestamp": burn_stats.get("timestamp", 0)
        })
        
    except Exception as e:
        current_app.logger.error(f"Error getting current prices: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@pricing_bp.route('/price_for_node', methods=['POST'])
def get_price_for_node():
    """Get activation price for specific node type"""
    try:
        data = request.get_json()
        node_type_str = data.get("node_type", "light").lower()
        
        # Validate node type
        try:
            node_type = NodeType(node_type_str)
        except ValueError:
            return jsonify({
                "success": False,
                "error": f"Invalid node type: {node_type_str}"
            }), 400
        
        # Get burn statistics
        burn_stats = get_current_burn_stats()
        total_burned = burn_stats["total_burned"]
        
        # Calculate price
        burn_requirement = onedev_calculator.calculate_burn_requirement(
            node_type, 
            total_burned
        )
        
        # Apply transition protection if needed
        if burn_requirement["token"] == "QNC":
            # Get protected price during transition
            active_nodes = get_active_nodes_count()
            base_price = qnc_calculator.calculate_price(node_type, active_nodes)
            
            # Apply protection (simplified - would use price history in production)
            protected_price = transition_manager.calculate_protected_price(
                base_price=base_price,
                previous_price=base_price * 0.9,  # Mock previous price
                transition_progress=burn_requirement["burn_ratio"] / 0.9
            )
            
            burn_requirement["amount"] = protected_price
            burn_requirement["protection_applied"] = True
        
        return jsonify({
            "success": True,
            "data": burn_requirement
        })
        
    except Exception as e:
        current_app.logger.error(f"Error calculating price for node: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@pricing_bp.route('/burn_progress', methods=['GET'])
def get_burn_progress():
    """Get detailed 1DEV burn progress and analytics"""
    try:
        burn_stats = get_current_burn_stats()
        
        # Analyze burn progress
        progress = burn_tracker.analyze_burn_progress(
            total_burned=burn_stats["total_burned"],
            burn_rate_per_day=burn_stats["burn_rate_per_day"]
        )
        
        # Add transition status
        transition_status = transition_manager.calculate_transition_metrics(
            onedev_burned=burn_stats["total_burned"],
            onedev_total_supply=1_000_000_000,
            days_elapsed=burn_stats["days_since_launch"]
        )
        
        return jsonify({
            "success": True,
            "data": {
                "burn_progress": progress,
                "transition_status": transition_status,
                "current_stats": burn_stats
            }
        })
        
    except Exception as e:
        current_app.logger.error(f"Error getting burn progress: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@pricing_bp.route('/value_preservation', methods=['POST'])
def calculate_value_preservation():
    """Calculate value preservation for 1DEV holders"""
    try:
        data = request.get_json()
        onedev_holdings = data.get("onedev_holdings", 0)
        
        if onedev_holdings <= 0:
            return jsonify({
                "success": False,
                "error": "Invalid 1DEV holdings amount"
            }), 400
        
        burn_stats = get_current_burn_stats()
        
        # Calculate value preservation
        value_info = onedev_calculator.estimate_onedev_value_preservation(
            onedev_holdings=onedev_holdings,
            total_onedev_burned=burn_stats["total_burned"]
        )
        
        # Add holder benefits
        holder_benefits = transition_manager.get_onedev_holder_benefits(
            is_onedev_holder=True,
            days_since_transition=0  # Not transitioned yet
        )
        
        return jsonify({
            "success": True,
            "data": {
                "value_preservation": value_info,
                "holder_benefits": holder_benefits
            }
        })
        
    except Exception as e:
        current_app.logger.error(f"Error calculating value preservation: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@pricing_bp.route('/price_history', methods=['GET'])
def get_price_history():
    """Get historical pricing data"""
    try:
        # TODO: Implement actual historical data retrieval
        # For now, return mock data showing price progression
        
        mock_history = [
            {"date": "2024-01-01", "light": 1500, "full": 1500, "super": 1500, "token": "1DEV", "burned_percent": 0},
            {"date": "2024-02-01", "light": 1350, "full": 1350, "super": 1350, "token": "1DEV", "burned_percent": 10},
            {"date": "2024-03-01", "light": 1200, "full": 1200, "super": 1200, "token": "1DEV", "burned_percent": 25},
            {"date": "2024-04-01", "light": 950, "full": 950, "super": 950, "token": "1DEV", "burned_percent": 50},
            {"date": "2024-05-01", "light": 750, "full": 750, "super": 750, "token": "1DEV", "burned_percent": 75},
            {"date": "2024-06-01", "light": 500, "full": 500, "super": 500, "token": "1DEV", "burned_percent": 85},
        ]
        
        return jsonify({
            "success": True,
            "data": {
                "history": mock_history,
                "note": "Mock data - actual implementation pending"
            }
        })
        
    except Exception as e:
        current_app.logger.error(f"Error getting price history: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@pricing_bp.route('/simulate_pricing', methods=['POST'])
def simulate_pricing():
    """Simulate pricing at different burn/network states"""
    try:
        data = request.get_json()
        
        # Get simulation parameters
        burned_percent = data.get("burned_percent", 0)
        total_nodes = data.get("total_nodes", 10000)
        node_distribution = data.get("distribution", {"light": 0.7, "full": 0.25, "super": 0.05})
        
        # Calculate burned amount
        total_burned = (burned_percent / 100) * 1_000_000_000
        
        # Calculate node counts
        active_nodes = {
            NodeType.LIGHT: int(total_nodes * node_distribution["light"]),
            NodeType.FULL: int(total_nodes * node_distribution["full"]),
            NodeType.SUPER: int(total_nodes * node_distribution["super"])
        }
        
        # Get prices
        if burned_percent >= 90:
            # QNC pricing
            prices = qnc_calculator.get_price_schedule(active_nodes)
            result = {
                "token": "QNC",
                "prices": {
                    "light": prices[NodeType.LIGHT],
                    "full": prices[NodeType.FULL],
                    "super": prices[NodeType.SUPER]
                }
            }
        else:
            # 1DEV pricing
            schedule = onedev_calculator.get_burn_schedule(total_burned)
            result = {
                "token": "1DEV",
                "prices": {
                    "light": schedule["light"]["amount"],
                    "full": schedule["full"]["amount"],
                    "super": schedule["super"]["amount"]
                }
            }
        
        result["parameters"] = {
            "burned_percent": burned_percent,
            "total_nodes": total_nodes,
            "node_distribution": node_distribution
        }
        
        return jsonify({
            "success": True,
            "data": result
        })
        
    except Exception as e:
        current_app.logger.error(f"Error in pricing simulation: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

# Error handlers
@pricing_bp.errorhandler(400)
def handle_bad_request(error):
    return jsonify({
        "success": False,
        "error": "Bad Request",
        "message": str(error.description) if hasattr(error, 'description') else "Invalid request"
    }), 400

@pricing_bp.errorhandler(500)
def handle_internal_error(error):
    current_app.logger.error(f"Internal error in pricing API: {error}")
    return jsonify({
        "success": False,
        "error": "Internal Server Error"
    }), 500 