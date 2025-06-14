"""
State management for QNet blockchain.
Provides compatibility layer for Python code.
"""

from typing import Any, Dict, Optional


class State:
    """Simple state management class."""
    
    def __init__(self):
        """Initialize state storage."""
        self._data: Dict[str, Any] = {}
    
    def get(self, key: str) -> Optional[Any]:
        """Get value by key."""
        return self._data.get(key)
    
    def set(self, key: str, value: Any) -> None:
        """Set value by key."""
        self._data[key] = value
    
    def delete(self, key: str) -> None:
        """Delete value by key."""
        if key in self._data:
            del self._data[key]
    
    def exists(self, key: str) -> bool:
        """Check if key exists."""
        return key in self._data
    
    def clear(self) -> None:
        """Clear all state."""
        self._data.clear()
    
    def get_all(self) -> Dict[str, Any]:
        """Get all state data."""
        return self._data.copy() 