"""
Push Notification System for QNet Rewards
Handles notifications about missed rewards, earned rewards, and node status
"""

import json
import logging
import asyncio
from typing import Dict, List, Optional
from dataclasses import dataclass
from enum import Enum
import time

logger = logging.getLogger(__name__)

class NotificationType(Enum):
    """Types of push notifications"""
    INCOMING_TRANSACTION = "incoming_transaction"
    REWARD_EARNED = "reward_earned"
    REWARD_MISSED = "reward_missed"
    PING_REQUIRED = "ping_required"
    NODE_QUARANTINED = "node_quarantined"
    NODE_RESTORED = "node_restored"
    NETWORK_ALERT = "network_alert"

@dataclass
class PushToken:
    """Push notification token for a device"""
    node_id: str
    platform: str  # "android", "ios", "web"
    token: str
    last_updated: int
    active: bool = True

@dataclass
class NotificationMessage:
    """Push notification message"""
    title: str
    body: str
    data: Dict
    priority: str = "normal"  # "normal", "high"

class PushNotificationManager:
    """Manages push notifications for mobile nodes"""
    
    def __init__(self):
        self.registered_tokens: Dict[str, List[PushToken]] = {}  # node_id -> tokens
        self.notification_history: List[Dict] = []
        
        # Rate limiting: Max 10 notifications per hour per node
        self.rate_limits: Dict[str, List[int]] = {}
        self.max_notifications_per_hour = 10
        
        logger.info("Push Notification Manager initialized")
    
    def register_device(self, node_id: str, platform: str, token: str) -> bool:
        """Register device for push notifications"""
        if node_id not in self.registered_tokens:
            self.registered_tokens[node_id] = []
        
        # Check if token already exists and update it
        for existing_token in self.registered_tokens[node_id]:
            if existing_token.token == token:
                existing_token.last_updated = int(time.time())
                existing_token.active = True
                logger.info(f"Updated push token for node {node_id} on {platform}")
                return True
        
        # Add new token
        push_token = PushToken(
            node_id=node_id,
            platform=platform,
            token=token,
            last_updated=int(time.time())
        )
        
        self.registered_tokens[node_id].append(push_token)
        logger.info(f"Registered new push token for node {node_id} on {platform}")
        return True
    
    def unregister_device(self, node_id: str, token: str) -> bool:
        """Unregister device from push notifications"""
        if node_id not in self.registered_tokens:
            return False
        
        for push_token in self.registered_tokens[node_id]:
            if push_token.token == token:
                push_token.active = False
                logger.info(f"Unregistered push token for node {node_id}")
                return True
        
        return False
    
    def _check_rate_limit(self, node_id: str) -> bool:
        """Check if node is within rate limit"""
        current_time = int(time.time())
        one_hour_ago = current_time - 3600
        
        if node_id not in self.rate_limits:
            self.rate_limits[node_id] = []
        
        # Remove notifications older than 1 hour
        self.rate_limits[node_id] = [
            timestamp for timestamp in self.rate_limits[node_id] 
            if timestamp > one_hour_ago
        ]
        
        # Check if within limit
        if len(self.rate_limits[node_id]) >= self.max_notifications_per_hour:
            logger.warning(f"Rate limit exceeded for node {node_id}")
            return False
        
        # Add current notification to rate limit tracker
        self.rate_limits[node_id].append(current_time)
        return True
    
    async def send_notification(self, node_id: str, notification_type: NotificationType, 
                              title: str, body: str, data: Dict = None) -> bool:
        """Send push notification to a node"""
        if not self._check_rate_limit(node_id):
            return False
        
        if node_id not in self.registered_tokens:
            logger.debug(f"No push tokens registered for node {node_id}")
            return False
        
        if data is None:
            data = {}
        
        data.update({
            "type": notification_type.value,
            "timestamp": int(time.time()),
            "node_id": node_id
        })
        
        message = NotificationMessage(
            title=title,
            body=body,
            data=data,
            priority="high" if notification_type in [
                NotificationType.PING_REQUIRED, 
                NotificationType.REWARD_MISSED
            ] else "normal"
        )
        
        # Send to all active tokens for this node
        sent_count = 0
        for push_token in self.registered_tokens[node_id]:
            if not push_token.active:
                continue
                
            success = await self._send_platform_notification(push_token, message)
            if success:
                sent_count += 1
        
        # Log notification
        self.notification_history.append({
            "node_id": node_id,
            "type": notification_type.value,
            "title": title,
            "body": body,
            "data": data,
            "sent_count": sent_count,
            "timestamp": int(time.time())
        })
        
        if sent_count > 0:
            logger.info(f"Sent {notification_type.value} notification to node {node_id} ({sent_count} devices)")
        
        return sent_count > 0
    
    async def _send_platform_notification(self, push_token: PushToken, 
                                        message: NotificationMessage) -> bool:
        """Send notification to specific platform"""
        try:
            if push_token.platform == "android":
                return await self._send_fcm_notification(push_token, message)
            elif push_token.platform == "ios":
                return await self._send_apns_notification(push_token, message)
            elif push_token.platform == "web":
                return await self._send_web_push_notification(push_token, message)
            else:
                logger.warning(f"Unsupported platform: {push_token.platform}")
                return False
        except Exception as e:
            logger.error(f"Error sending notification to {push_token.platform}: {e}")
            return False
    
    async def _send_fcm_notification(self, push_token: PushToken, 
                                   message: NotificationMessage) -> bool:
        """Send FCM notification (Android)"""
        # TODO: Implement FCM sending
        # For now, simulate success
        logger.debug(f"FCM notification sent to {push_token.token[:10]}...")
        return True
    
    async def _send_apns_notification(self, push_token: PushToken, 
                                    message: NotificationMessage) -> bool:
        """Send APNS notification (iOS)"""
        # TODO: Implement APNS sending
        # For now, simulate success
        logger.debug(f"APNS notification sent to {push_token.token[:10]}...")
        return True
    
    async def _send_web_push_notification(self, push_token: PushToken, 
                                        message: NotificationMessage) -> bool:
        """Send Web Push notification (Browser)"""
        # TODO: Implement Web Push sending
        # For now, simulate success
        logger.debug(f"Web Push notification sent to {push_token.token[:10]}...")
        return True
    
    # Specific notification methods
    
    async def notify_reward_earned(self, node_id: str, amount: float, 
                                 reward_type: str) -> bool:
        """Notify about earned rewards"""
        return await self.send_notification(
            node_id=node_id,
            notification_type=NotificationType.REWARD_EARNED,
            title="Reward Earned! 💰",
            body=f"You earned {amount:.2f} QNC from {reward_type}",
            data={
                "amount": amount,
                "reward_type": reward_type,
                "action": "claim_rewards"
            }
        )
    
    async def notify_reward_missed(self, node_id: str, amount: float, 
                                 reason: str) -> bool:
        """Notify about missed rewards"""
        return await self.send_notification(
            node_id=node_id,
            notification_type=NotificationType.REWARD_MISSED,
            title="Missed Reward ⚠️",
            body=f"You missed {amount:.2f} QNC - {reason}",
            data={
                "amount": amount,
                "reason": reason,
                "action": "check_node_status"
            }
        )
    
    async def notify_network_ping_incoming(self, node_id: str, slot_time_minutes: int) -> bool:
        """Notify that network will ping this node soon in assigned slot"""
        return await self.send_notification(
            node_id=node_id,
            notification_type=NotificationType.PING_REQUIRED,
            title="Network Ping Incoming 📡",
            body=f"Network will ping your node in {slot_time_minutes} minutes. Be ready to respond!",
            data={
                "slot_time_minutes": slot_time_minutes,
                "action": "prepare_for_ping"
            }
        )
    
    async def notify_node_quarantined(self, node_id: str, quarantine_days: int) -> bool:
        """Notify that node is quarantined"""
        return await self.send_notification(
            node_id=node_id,
            notification_type=NotificationType.NODE_QUARANTINED,
            title="Node Quarantined 🔒",
            body=f"Your node is quarantined for {quarantine_days} days. No rewards during this period.",
            data={
                "quarantine_days": quarantine_days,
                "action": "check_node_status"
            }
        )
    
    async def notify_node_restored(self, node_id: str) -> bool:
        """Notify that node is restored and active"""
        return await self.send_notification(
            node_id=node_id,
            notification_type=NotificationType.NODE_RESTORED,
            title="Node Restored ✅",
            body="Your node is active again and eligible for rewards!",
            data={
                "action": "check_rewards"
            }
        )
    
    async def notify_incoming_transaction(self, node_id: str, amount: float, 
                                        from_address: str) -> bool:
        """Notify about incoming transaction"""
        return await self.send_notification(
            node_id=node_id,
            notification_type=NotificationType.INCOMING_TRANSACTION,
            title="Payment Received 💸",
            body=f"Received {amount:.6f} QNC from {from_address[:10]}...",
            data={
                "amount": amount,
                "from_address": from_address,
                "action": "view_transaction"
            }
        )
    
    def cleanup_old_tokens(self, days: int = 30) -> int:
        """Remove tokens older than specified days"""
        cutoff_time = int(time.time()) - (days * 24 * 60 * 60)
        cleaned = 0
        
        for node_id, tokens in self.registered_tokens.items():
            original_count = len(tokens)
            self.registered_tokens[node_id] = [
                token for token in tokens 
                if token.last_updated > cutoff_time and token.active
            ]
            cleaned += original_count - len(self.registered_tokens[node_id])
        
        logger.info(f"Cleaned up {cleaned} old push tokens")
        return cleaned
    
    def get_stats(self) -> Dict:
        """Get push notification statistics"""
        total_tokens = sum(len(tokens) for tokens in self.registered_tokens.values())
        active_tokens = sum(
            len([t for t in tokens if t.active]) 
            for tokens in self.registered_tokens.values()
        )
        
        recent_notifications = len([
            n for n in self.notification_history 
            if n["timestamp"] > int(time.time()) - 3600  # Last hour
        ])
        
        return {
            "total_nodes_registered": len(self.registered_tokens),
            "total_tokens": total_tokens,
            "active_tokens": active_tokens,
            "recent_notifications": recent_notifications,
            "notification_history_size": len(self.notification_history)
        } 