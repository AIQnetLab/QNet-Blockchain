# File: QNet-Project/qnet-node/src/api/activation_bridge_api.py
# -*- coding: utf-8 -*-
"""
Module: activation_bridge_api.py
Blueprint for the API used by the website to facilitate node activation.
Checks Solana "burn" transactions (transfer to a dead address) and helps generate Activation Tokens.
Compatible with solana 0.36.6 and solders 0.26.0
"""
from flask import Blueprint, jsonify, request, current_app
import logging
import base64
import json
import time
import hashlib
import os
from typing import Tuple, Optional, Dict, Any

# Import AppConfig to access configuration
import sys
current_dir_bridge = os.path.dirname(os.path.abspath(__file__))
src_dir_bridge = os.path.abspath(os.path.join(current_dir_bridge, '..'))
project_root_bridge = os.path.abspath(os.path.join(current_dir_bridge, '..', '..', '..'))

if src_dir_bridge not in sys.path:
    sys.path.insert(0, src_dir_bridge)
if project_root_bridge not in sys.path:
    sys.path.insert(0, project_root_bridge)

try:
    from config_loader import AppConfig, get_config
except ImportError:
    logging.basicConfig(level=logging.ERROR)
    logging.error("CRITICAL: Failed to import AppConfig from config_loader. Ensure it's in PYTHONPATH or accessible.")
    class AppConfig:
        def get(self, section: str, key: str, fallback: Any = None) -> Any: return fallback
        def getint(self, section: str, key: str, fallback: Any = None) -> Any: return fallback
        def getfloat(self, section: str, key: str, fallback: Any = None) -> Any: return fallback
        def getboolean(self, section: str, key: str, fallback: Any = None) -> Any: return fallback
    def get_config() -> AppConfig: return AppConfig()

# Import issuer key manager
try:
    from issuer_key_manager import get_issuer_keypair
    ISSUER_KEY_MANAGER_AVAILABLE = True
except ImportError as ikm_error:
    ISSUER_KEY_MANAGER_AVAILABLE = False
    logging.warning(f"Issuer key manager not available: {ikm_error}")

# Solana imports for version 0.36.6
try:
    from solana.rpc.api import Client
    from solana.exceptions import SolanaRpcException
    from solders.pubkey import Pubkey
    from solders.signature import Signature
    from solders.keypair import Keypair
    
    SOLANA_PY_AVAILABLE = True
    SOLDERS_AVAILABLE = True
    
    # Log versions
    try:
        import solana
        import solders
        solana_version = getattr(solana, '__version__', 'unknown')
        solders_version = getattr(solders, '__version__', 'unknown')
        logging.info(f"Loaded solana version: {solana_version}")
        logging.info(f"Loaded solders version: {solders_version}")
        logging.info("Using latest Solana APIs with solders backend")
    except Exception as e:
        logging.warning(f"Could not log version info: {e}")
        
except ImportError as e_sol:
    SOLANA_PY_AVAILABLE = False
    SOLDERS_AVAILABLE = False
    logging.error(f"CRITICAL: Solana Python libraries not found: {e_sol}. Activation Bridge cannot function without Solana libraries.")
    
    # System cannot function without these libraries - fail fast
    raise ImportError(f"Required Solana libraries missing: {e_sol}. Please install: pip install solana solders") from e_sol

# PyNaCl for signature verification
try:
    import nacl.signing
    import nacl.exceptions
    import base58
    PYNACL_AVAILABLE = True
except ImportError as e_nacl:
    PYNACL_AVAILABLE = False
    logging.warning(f"PyNaCl or base58 library not available: {e_nacl}")

activation_bp = Blueprint('activation_bridge_api', __name__)

def create_solana_client(rpc_url: str) -> Client:
    """Create Solana client for version 0.36.6"""
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)
    
    try:
        # For solana 0.36.6, use the simple URL parameter
        client = Client(rpc_url)
        logger_func.info(f"Successfully created Solana client for {rpc_url}")
        return client
    except Exception as e:
        logger_func.error(f"Failed to create Solana client: {e}")
        raise Exception(f"Cannot create Solana client: {e}")

def parse_pubkey(pubkey_str: str):
    """Parse pubkey string with version compatibility"""
    if not SOLANA_PY_AVAILABLE:
        return pubkey_str
    
    try:
        return Pubkey.from_string(pubkey_str)
    except Exception as e:
        logging.error(f"Failed to parse pubkey {pubkey_str}: {e}")
        return pubkey_str

def parse_signature(sig_str: str):
    """Parse signature string with version compatibility"""
    if not SOLANA_PY_AVAILABLE:
        return sig_str
    
    try:
        return Signature.from_string(sig_str)
    except Exception as e:
        logging.error(f"Failed to parse signature {sig_str}: {e}")
        return sig_str

def get_transaction_with_compatibility(client: Client, tx_sig, encoding="jsonParsed"):
    """Get transaction for solana 0.36.6"""
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)
    
    try:
        # For solana 0.36.6, this is the correct format
        response = client.get_transaction(
            tx_sig, 
            encoding=encoding,
            max_supported_transaction_version=0
        )
        logger_func.debug("Successfully retrieved transaction")
        return response
    except Exception as e:
        logger_func.error(f"Failed to get transaction: {e}")
        return None

def extract_account_keys(transaction_message):
    """Extract account keys with version compatibility"""
    account_keys = None
    
    # Try different attribute names across versions
    for attr_name in ['account_keys', 'accountKeys', 'static_account_keys']:
        if hasattr(transaction_message, attr_name):
            account_keys = getattr(transaction_message, attr_name)
            logging.debug(f"Found account keys via {attr_name}")
            break
    
    return account_keys

def extract_instructions(transaction_message):
    """Extract instructions with version compatibility"""
    instructions = None
    
    # Try different attribute names across versions
    for attr_name in ['instructions', 'compiled_instructions', 'compiledInstructions']:
        if hasattr(transaction_message, attr_name):
            instructions = getattr(transaction_message, attr_name)
            logging.debug(f"Found instructions via {attr_name}")
            break
    
    return instructions

def extract_meta(tx_response):
    """Extract transaction meta with version compatibility"""
    if not tx_response or not tx_response.value:
        return None
    
    tx_with_meta = tx_response.value
    
    # For solana 0.36.6, meta should be directly accessible
    if hasattr(tx_with_meta, 'meta'):
        return tx_with_meta.meta
    
    # Fallback methods
    if hasattr(tx_with_meta, 'transaction') and hasattr(tx_with_meta.transaction, 'meta'):
        return tx_with_meta.transaction.meta
    
    # Search all attributes for meta-like objects
    for attr_name in dir(tx_with_meta):
        if 'meta' in attr_name.lower() and not attr_name.startswith('_'):
            attr_value = getattr(tx_with_meta, attr_name, None)
            if attr_value and (hasattr(attr_value, 'err') or 
                              hasattr(attr_value, 'pre_token_balances') or
                              hasattr(attr_value, 'post_token_balances')):
                logging.debug(f"Found meta via attribute '{attr_name}'")
                return attr_value
    
    return None

def extract_transaction_message(tx_with_meta):
    """Extract transaction message with version compatibility"""
    # For solana 0.36.6, should be direct access
    if hasattr(tx_with_meta, 'transaction') and hasattr(tx_with_meta.transaction, 'message'):
        return tx_with_meta.transaction.message
    
    # Fallback methods
    transaction_obj = getattr(tx_with_meta, 'transaction', tx_with_meta)
    
    if hasattr(transaction_obj, 'message'):
        return transaction_obj.message
    elif hasattr(transaction_obj, 'transaction') and hasattr(transaction_obj.transaction, 'message'):
        return transaction_obj.transaction.message
    else:
        # Search for message-like objects
        for attr_name in dir(transaction_obj):
            if not attr_name.startswith('_'):
                try:
                    attr_value = getattr(transaction_obj, attr_name)
                    if hasattr(attr_value, 'account_keys') or hasattr(attr_value, 'instructions'):
                        logging.debug(f"Found message-like object in attribute '{attr_name}'")
                        return attr_value
                except Exception:
                    continue
    
    return None

def check_solana_burn_tx_details(
    solana_client: Client,
    solana_txid_str: str,
    expected_sender_pubkey_str: str,
    expected_mint_str: str,
    expected_burn_address_str: str,
    min_amount_units: int
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    cfg = get_config()
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)

    if not SOLANA_PY_AVAILABLE:
        logger_func.error("CRITICAL: Solana libraries not available. Cannot validate burn transactions.")
        return False, "Solana validation libraries not available in the backend.", None

    # Test RPC connection first
    try:
        logger_func.info("Testing RPC connection...")
        test_response = solana_client.get_latest_blockhash()
        logger_func.info(f"RPC connection test successful: {test_response}")
    except Exception as rpc_test_error:
        logger_func.error(f"RPC connection test failed: {rpc_test_error}")
        logger_func.error(f"RPC test error type: {type(rpc_test_error)}")
        logger_func.error(f"RPC test error repr: {repr(rpc_test_error)}")
        return False, f"RPC connection failed: {rpc_test_error}", None

    try:
        # Parse inputs using solders
        tx_sig = parse_signature(solana_txid_str)
        expected_sender_pk = parse_pubkey(expected_sender_pubkey_str)
        expected_burn_pk = parse_pubkey(expected_burn_address_str)

        logger_func.info(f"Fetching transaction details for: {solana_txid_str}")
        tx_response = get_transaction_with_compatibility(solana_client, tx_sig)
        logger_func.info(f"Transaction response received: {tx_response is not None}")

        if not tx_response or not tx_response.value:
            logger_func.warning(f"Transaction not found or empty response for: {solana_txid_str}")
            return False, "Transaction not found on Solana.", None

        tx_with_meta = tx_response.value
        
        # Debug information for structure analysis
        logger_func.debug(f"Transaction object type: {type(tx_with_meta)}")
        logger_func.debug(f"Transaction object attributes: {[attr for attr in dir(tx_with_meta) if not attr.startswith('_')]}")
        
        if not tx_with_meta or not hasattr(tx_with_meta, 'transaction'):
            return False, "Could not parse transaction details.", None

        # Extract meta with compatibility
        meta = extract_meta(tx_response)
        if meta is None:
            return False, "Cannot access transaction metadata - please check solana library version compatibility.", None

        logger_func.debug(f"Meta object type: {type(meta)}")
        logger_func.debug(f"Meta object attributes: {[attr for attr in dir(meta) if not attr.startswith('_')]}")

        # Check for transaction errors
        if hasattr(meta, 'err') and meta.err:
            error_msg = str(meta.err)
            logger_func.error(f"Transaction failed on Solana: {error_msg}")
            return False, f"Transaction failed on Solana: {error_msg}", None

        # Extract transaction message
        transaction_message = extract_transaction_message(tx_with_meta)
        if transaction_message is None:
            logger_func.error("Transaction message missing.")
            return False, "Transaction message missing.", None

        # Extract account keys
        account_keys = extract_account_keys(transaction_message)
        if account_keys is None:
            logger_func.error("Transaction account keys missing.")
            return False, "Transaction account keys missing.", None

        logger_func.debug(f"Found {len(account_keys)} account keys")

        # Verify sender is signer - enhanced debugging
        is_sender_signer = False
        logger_func.debug(f"Expected sender pubkey: {expected_sender_pk}")
        
        if account_keys:
            logger_func.debug("Account keys in transaction:")
            for i, acc_key_obj in enumerate(account_keys):
                logger_func.debug(f"  [{i}]: {acc_key_obj}")
                
                try:
                    # For solana 0.36.6, account keys should be ParsedAccount objects
                    account_pubkey = None
                    if hasattr(acc_key_obj, 'pubkey'):
                        account_pubkey = str(acc_key_obj.pubkey)
                    else:
                        account_pubkey = str(acc_key_obj)
                    
                    logger_func.debug(f"Comparing: '{account_pubkey}' vs '{str(expected_sender_pk)}'")
                    
                    if account_pubkey == str(expected_sender_pk):
                        logger_func.debug(f"✓ Found expected sender at index {i}")
                        
                        # Check if this account is marked as signer
                        is_signer = False
                        if hasattr(acc_key_obj, 'signer'):
                            is_signer = acc_key_obj.signer
                            logger_func.debug(f"Account has signer attribute: {is_signer}")
                        else:
                            # Fallback: check by position (first N accounts are signers)
                            num_required_signatures = 0
                            if hasattr(transaction_message, 'header'):
                                if hasattr(transaction_message.header, 'num_required_signatures'):
                                    num_required_signatures = transaction_message.header.num_required_signatures
                                elif hasattr(transaction_message.header, 'numRequiredSignatures'):
                                    num_required_signatures = transaction_message.header.numRequiredSignatures
                            
                            is_signer = i < num_required_signatures
                            logger_func.debug(f"Determined signer status by position: {is_signer} (index {i} < {num_required_signatures})")
                        
                        if is_signer:
                            is_sender_signer = True
                            logger_func.info(f"✓ Sender verified as signer at index {i}")
                            break
                        else:
                            logger_func.warning(f"Expected sender found at index {i} but is NOT a signer")
                    else:
                        logger_func.debug(f"Account at index {i} does NOT match expected sender")
                        
                except Exception as e:
                    logger_func.debug(f"Error comparing account key at index {i}: {e}")
                    continue
        
        if not is_sender_signer:
            logger_func.warning("Expected sender is not a signer of this transaction.")
            logger_func.warning(f"Expected sender: {expected_sender_pk}")
            logger_func.warning("All accounts in transaction:")
            for i, acc_key_obj in enumerate(account_keys):
                if hasattr(acc_key_obj, 'pubkey') and hasattr(acc_key_obj, 'signer'):
                    logger_func.warning(f"  [{i}]: {acc_key_obj.pubkey} (signer: {acc_key_obj.signer})")
                else:
                    logger_func.warning(f"  [{i}]: {acc_key_obj}")
            return False, "Expected sender is not a signer of this transaction.", None

        # Process instructions to find valid transfers
        found_valid_transfer = False
        actual_amount_transferred_units = 0

        # Get instructions - handle different attribute names
        instructions = extract_instructions(transaction_message)
        if instructions:
            logger_func.debug(f"Processing {len(instructions)} instructions")
            
            for ix_idx, ix_obj in enumerate(instructions):
                logger_func.debug(f"Processing instruction {ix_idx}: {type(ix_obj)}")
                
                # Get parsed instruction info
                parsed_info_dict = None
                
                # Method 1: Direct parsed attribute
                if hasattr(ix_obj, 'parsed') and isinstance(ix_obj.parsed, dict):
                    parsed_info_dict = ix_obj.parsed
                    logger_func.debug(f"Found parsed data via direct access")
                
                # Method 2: Dictionary format
                elif isinstance(ix_obj, dict) and "parsed" in ix_obj:
                    parsed_info_dict = ix_obj["parsed"]
                    logger_func.debug(f"Found parsed data via dict access")
                
                # Method 3: Check if instruction has type and info attributes
                elif hasattr(ix_obj, 'type') and hasattr(ix_obj, 'info'):
                    parsed_info_dict = {
                        'type': ix_obj.type,
                        'info': ix_obj.info if isinstance(ix_obj.info, dict) else {}
                    }
                    logger_func.debug(f"Found parsed data via type/info attributes")
                
                # Method 4: Compiled instruction - check program ID
                elif hasattr(ix_obj, 'program_id_index'):
                    try:
                        program_id_index = ix_obj.program_id_index
                        if program_id_index < len(account_keys):
                            program_id = account_keys[program_id_index]
                            logger_func.debug(f"Instruction {ix_idx} program ID: {program_id}")
                            
                            # Check if this is a Token program instruction
                            if str(program_id) == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":
                                logger_func.debug(f"Found SPL Token program instruction (compiled)")
                                # For compiled instructions, we need to analyze the balance changes
                                continue
                    except Exception as e:
                        logger_func.debug(f"Error processing compiled instruction: {e}")
                        continue
                else:
                    logger_func.debug(f"Skipping instruction {ix_idx} - cannot determine format")
                    continue

                if not parsed_info_dict:
                    continue

                logger_func.debug(f"Parsed instruction {ix_idx}: type={parsed_info_dict.get('type')}")

                # Check if this is a token transfer instruction
                instruction_type = parsed_info_dict.get("type", "")
                if instruction_type in ["transfer", "transferChecked"]:
                    info = parsed_info_dict.get("info", {})
                    
                    # Handle different authority field names - enhanced for multisig
                    authority_str = None
                    if "multisigAuthority" in info:
                        authority_str = info["multisigAuthority"]
                        logger_func.debug("Using multisigAuthority as authority")
                    elif "authority" in info:
                        authority_str = info["authority"]
                        logger_func.debug("Using authority field")
                    elif "owner" in info:
                        authority_str = info["owner"]
                        logger_func.debug("Using owner as authority")
                    elif "signers" in info and info["signers"]:
                        # Use first signer if available
                        authority_str = info["signers"][0]
                        logger_func.debug("Using first signer as authority")
                    elif "source" in info:
                        authority_str = info["source"]
                        logger_func.debug("Using source as authority")
                    elif "from" in info:
                        authority_str = info["from"]
                        logger_func.debug("Using from as authority")
                    
                    # Handle different amount formats
                    amount_val_from_info = None
                    if "tokenAmount" in info and isinstance(info["tokenAmount"], dict):
                        amount_val_from_info = info["tokenAmount"].get("amount")
                        logger_func.debug("Using tokenAmount.amount")
                    elif "amount" in info:
                        amount_val_from_info = info["amount"]
                        logger_func.debug("Using direct amount")
                    
                    destination_acct_str = info.get("destination")

                    logger_func.debug(f"Transfer instruction - Authority: {authority_str}, Amount: {amount_val_from_info}, Dest: {destination_acct_str}")
                    logger_func.debug(f"Full info object: {info}")

                    if not all([authority_str, destination_acct_str, amount_val_from_info is not None]):
                        logger_func.debug(f"Skipping transfer instruction due to missing info")
                        logger_func.debug(f"  Authority present: {authority_str is not None}")
                        logger_func.debug(f"  Destination present: {destination_acct_str is not None}")
                        logger_func.debug(f"  Amount present: {amount_val_from_info is not None}")
                        continue

                    # Parse amount
                    try:
                        instruction_amount_units = int(str(amount_val_from_info))
                    except (ValueError, TypeError) as e:
                        logger_func.warning(f"Could not parse amount: {amount_val_from_info}, error: {e}")
                        continue

                    # Check if transfer is from expected sender
                    if str(authority_str) == str(expected_sender_pk):
                        logger_func.debug(f"Found transfer from expected sender: {instruction_amount_units} units")
                        
                        # Verify destination is burn address by checking token balances
                        destination_owner_is_burn_pk = False
                        
                        # Check post-transaction token balances
                        post_token_balances = getattr(meta, 'post_token_balances', None)
                        pre_token_balances = getattr(meta, 'pre_token_balances', None)
                        
                        if post_token_balances:
                            logger_func.debug(f"Checking {len(post_token_balances)} post-transaction token balances")
                            
                            for post_bal in post_token_balances:
                                # Handle different attribute names for mint and owner
                                mint = None
                                if hasattr(post_bal, 'mint'):
                                    mint = post_bal.mint
                                elif hasattr(post_bal, 'token_mint'):
                                    mint = post_bal.token_mint
                                
                                owner_address = None
                                if hasattr(post_bal, 'owner_address'):
                                    owner_address = post_bal.owner_address
                                elif hasattr(post_bal, 'owner'):
                                    owner_address = post_bal.owner
                                
                                logger_func.debug(f"Post balance - Mint: {mint}, Owner: {owner_address}")
                                
                                # Compare mint addresses (handle Pubkey objects vs strings)
                                mint_matches = False
                                if mint and expected_mint_str:
                                    if str(mint) == str(expected_mint_str):
                                        mint_matches = True
                                        logger_func.debug(f"Comparing mint: '{str(mint)}' == '{str(expected_mint_str)}' = True")
                                    else:
                                        logger_func.debug(f"Comparing mint: '{str(mint)}' == '{str(expected_mint_str)}' = False")
                                        logger_func.debug(f"Mint type: {type(mint)}, Expected mint type: {type(expected_mint_str)}")
                                        logger_func.debug(f"Mint repr: {repr(mint)}, Expected mint repr: {repr(expected_mint_str)}")
                                
                                owner_matches = False
                                if owner_address and expected_burn_pk:
                                    if str(owner_address) == str(expected_burn_pk):
                                        owner_matches = True
                                        logger_func.debug(f"Comparing owner: '{str(owner_address)}' == '{str(expected_burn_pk)}' = True")
                                    else:
                                        logger_func.debug(f"Comparing owner: '{str(owner_address)}' == '{str(expected_burn_pk)}' = False")
                                
                                if mint_matches and owner_matches:
                                    logger_func.debug(f"Found matching mint and burn address owner")
                                    
                                    # Calculate balance increase
                                    initial_balance = 0
                                    if pre_token_balances:
                                        account_index = getattr(post_bal, 'account_index', None)
                                        for pre_bal in pre_token_balances:
                                            if getattr(pre_bal, 'account_index', None) == account_index:
                                                ui_token_amount = getattr(pre_bal, 'ui_token_amount', None)
                                                if ui_token_amount:
                                                    amount = getattr(ui_token_amount, 'amount', None)
                                                    if amount is not None:
                                                        try:
                                                            initial_balance = int(amount)
                                                        except (ValueError, TypeError):
                                                            initial_balance = 0
                                                break
                                    
                                    # Get current balance
                                    current_balance = 0
                                    ui_token_amount = getattr(post_bal, 'ui_token_amount', None)
                                    if ui_token_amount:
                                        amount = getattr(ui_token_amount, 'amount', None)
                                        if amount is not None:
                                            try:
                                                current_balance = int(amount)
                                            except (ValueError, TypeError):
                                                current_balance = 0
                                    
                                    balance_increase = current_balance - initial_balance
                                    logger_func.debug(f"Balance increase: {balance_increase} (from {initial_balance} to {current_balance})")
                                    
                                    if (instruction_amount_units >= min_amount_units and 
                                        balance_increase >= min_amount_units):
                                        destination_owner_is_burn_pk = True
                                        actual_amount_transferred_units = instruction_amount_units
                                        logger_func.info(f"Valid burn transfer found: {actual_amount_transferred_units} units")
                                        break
                        
                        if destination_owner_is_burn_pk:
                            found_valid_transfer = True
                            break

                if found_valid_transfer:
                    break

        if found_valid_transfer:
            logger_func.info(f"Verified burn: {actual_amount_transferred_units} units of {expected_mint_str} to burn address")
            return True, "Token transfer to burn address verified.", {
                "sender_authority": expected_sender_pubkey_str,
                "recipient_owner": expected_burn_address_str,
                "mint": expected_mint_str,
                "amount_units_transferred": actual_amount_transferred_units,
            }
        else:
            logger_func.warning(f"No qualifying burn found in transaction {solana_txid_str}")
            return False, f"No confirmed qualifying transfer found in transaction instructions.", None

    except SolanaRpcException as e:
        error_details = str(e)
        if hasattr(e, 'error_msg') and callable(e.error_msg):
            error_details = e.error_msg()
        elif hasattr(e, 'args') and e.args:
            error_details = str(e.args[0])

        # Enhanced logging for debugging
        logger_func.error(f"Solana RPC Exception verifying tx {solana_txid_str}: {error_details}")
        logger_func.error(f"Exception type: {type(e)}")
        logger_func.error(f"Exception repr: {repr(e)}")
        logger_func.error(f"Exception args: {getattr(e, 'args', 'No args')}")

        return False, f"Solana RPC Error: {error_details}", None
    except ValueError as e:
        logger_func.error(f"ValueError verifying tx {solana_txid_str}: {e}")
        return False, f"Invalid input format (e.g., address, signature, amount): {e}", None
    except Exception as e:
        logger_func.error(f"Unexpected error verifying Solana transaction {solana_txid_str}: {e}", exc_info=True)
        return False, f"Internal error verifying transaction: {e}", None

def verify_solana_message_signature(
    solana_pubkey_b58_str: str,
    signature_b58_str: str,
    message_str: str
) -> Tuple[bool, str]:
    cfg = get_config()
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)

    logger_func.debug(f"Attempting to verify signature. PubKey: {solana_pubkey_b58_str}, Sig (first 10): {signature_b58_str[:10]}..., Message: {message_str[:30]}...")

    if not PYNACL_AVAILABLE:
        if cfg.getboolean("Activation", "mock_solana_checks", fallback=False):
            logger_func.warning("MOCK SUCCESS: PyNaCl not available, returning mock success for signature verification.")
            return True, "Mocked: Solana signature valid (PyNaCl not found)."
        return False, "PyNaCl library not available on the server for signature verification."

    try:
        pubkey_bytes = base58.b58decode(solana_pubkey_b58_str)
        if len(pubkey_bytes) != 32:
            logger_func.error(f"Decoded pubkey length is {len(pubkey_bytes)}, expected 32.")
            return False, "Invalid public key length after base58 decoding (expected 32 bytes)."

        # Enhanced signature decoding debugging
        logger_func.debug(f"Original Base58 signature string (len {len(signature_b58_str)}): '{signature_b58_str}'")
        try:
            signature_bytes = base58.b58decode(signature_b58_str)
            logger_func.info(f"Successfully decoded Base58 signature. Length of decoded bytes: {len(signature_bytes)}")
        except Exception as e_decode:
            logger_func.error(f"Error during base58.b58decode(signature_b58_str): {e_decode}", exc_info=True)
            return False, f"Base58 decoding of signature failed: {e_decode}"

        if len(signature_bytes) != 64:  # Ed25519 signatures are 64 bytes
            logger_func.error(f"Decoded signature length is {len(signature_bytes)}, expected 64.")
            return False, "Invalid signature length after base58 decoding (expected 64 bytes)."

        message_bytes = message_str.encode('utf-8')

        verify_key = nacl.signing.VerifyKey(pubkey_bytes)
        verify_key.verify(message_bytes, signature_bytes)  # This will raise BadSignatureError if invalid

        logger_func.info(f"Successfully verified Solana signature for pubkey: {solana_pubkey_b58_str[:10]}...")
        return True, "Signature valid."
    except nacl.exceptions.BadSignatureError:
        logger_func.warning(f"Solana signature invalid (BadSignatureError) for pubkey: {solana_pubkey_b58_str[:10]}...")
        return False, "Signature invalid."
    except ValueError as e:
        logger_func.error(f"ValueError during Solana signature verification (e.g. invalid base58 string for pubkey): {e}")
        return False, f"Invalid Base58 input for public key: {e}"
    except Exception as e:
        logger_func.error(f"Unexpected error verifying Solana message signature: {e}", exc_info=True)
        return False, f"Signature verification error: {e}"

def check_qnet_registry_for_pubkey(qnet_pubkey: str, app_cfg: AppConfig) -> Tuple[bool, str]:
    """Production implementation of QNet registry check for public key uniqueness"""
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)
    
    # Only use mock if explicitly configured for development
    if app_cfg.getboolean("Activation", "mock_qnet_registry_checks", fallback=False):
        logger_func.warning(f"MOCK QNET REGISTRY CHECK: QNet PubKey {qnet_pubkey[:10]}... assumed unique.")
        return True, "Mocked: QNet PubKey assumed unique."
    
    try:
        # PRODUCTION IMPLEMENTATION: Check against QNet state database
        import sqlite3
        import os
        
        # Create registry database if it doesn't exist
        registry_db_path = os.path.join("data", "qnet_registry.db")
        os.makedirs(os.path.dirname(registry_db_path), exist_ok=True)
        
        with sqlite3.connect(registry_db_path) as conn:
            # Create tables if they don't exist
            conn.execute('''
                CREATE TABLE IF NOT EXISTS registered_pubkeys (
                    qnet_pubkey TEXT PRIMARY KEY,
                    solana_txid TEXT,
                    registration_timestamp INTEGER,
                    node_type TEXT,
                    status TEXT DEFAULT 'active'
                )
            ''')
            
            # Check if pubkey already exists
            cursor = conn.execute(
                "SELECT qnet_pubkey, registration_timestamp FROM registered_pubkeys WHERE qnet_pubkey = ?",
                (qnet_pubkey,)
            )
            existing_record = cursor.fetchone()
            
            if existing_record:
                logger_func.warning(f"QNet PubKey {qnet_pubkey[:10]}... already registered at timestamp {existing_record[1]}")
                return False, f"QNet PubKey already registered. Registration timestamp: {existing_record[1]}"
            
            logger_func.info(f"QNet PubKey {qnet_pubkey[:10]}... is unique and available for registration")
            return True, "QNet PubKey is unique and available for registration"
            
    except Exception as e:
        logger_func.error(f"Error checking QNet registry for pubkey {qnet_pubkey[:10]}...: {e}")
        return False, f"Registry check failed: {str(e)}"

def check_qnet_registry_for_soltxid(solana_txid: str, app_cfg: AppConfig) -> Tuple[bool, str]:
    """Production implementation of QNet registry check for Solana transaction ID uniqueness"""
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)
    
    # Only use mock if explicitly configured for development
    if app_cfg.getboolean("Activation", "mock_qnet_registry_checks", fallback=False):
        logger_func.warning(f"MOCK QNET REGISTRY CHECK: Solana TxID {solana_txid[:10]}... assumed unique.")
        return True, "Mocked: Solana TxID assumed unique."
    
    try:
        # PRODUCTION IMPLEMENTATION: Check against QNet state database
        import sqlite3
        import os
        
        # Use the same registry database
        registry_db_path = os.path.join("data", "qnet_registry.db")
        os.makedirs(os.path.dirname(registry_db_path), exist_ok=True)
        
        with sqlite3.connect(registry_db_path) as conn:
            # Create tables if they don't exist
            conn.execute('''
                CREATE TABLE IF NOT EXISTS used_solana_txids (
                    solana_txid TEXT PRIMARY KEY,
                    qnet_pubkey TEXT,
                    usage_timestamp INTEGER,
                    burn_amount INTEGER,
                    verification_status TEXT DEFAULT 'verified'
                )
            ''')
            
            # Check if transaction ID already used
            cursor = conn.execute(
                "SELECT solana_txid, qnet_pubkey, usage_timestamp FROM used_solana_txids WHERE solana_txid = ?",
                (solana_txid,)
            )
            existing_record = cursor.fetchone()
            
            if existing_record:
                logger_func.warning(f"Solana TxID {solana_txid[:10]}... already used by QNet PubKey {existing_record[1][:10]}... at timestamp {existing_record[2]}")
                return False, f"Solana TxID already used by another QNet address. Usage timestamp: {existing_record[2]}"
            
            logger_func.info(f"Solana TxID {solana_txid[:10]}... is unique and available for use")
            return True, "Solana TxID is unique and available for use"
            
    except Exception as e:
        logger_func.error(f"Error checking QNet registry for Solana TxID {solana_txid[:10]}...: {e}")
        return False, f"Registry check failed: {str(e)}"

def register_successful_activation(qnet_pubkey: str, solana_txid: str, burn_details: Dict[str, Any], app_cfg: AppConfig) -> bool:
    """Register successful activation in QNet registry"""
    logger_func = current_app.logger if current_app else logging.getLogger(__name__)
    
    # Skip registration if using mocks
    if app_cfg.getboolean("Activation", "mock_qnet_registry_checks", fallback=False):
        logger_func.warning("Skipping registry registration due to mock mode")
        return True
    
    try:
        import sqlite3
        import os
        import time
        
        registry_db_path = os.path.join("data", "qnet_registry.db")
        os.makedirs(os.path.dirname(registry_db_path), exist_ok=True)
        
        current_timestamp = int(time.time())
        burn_amount = burn_details.get('amount_units_transferred', 0) if burn_details else 0
        
        with sqlite3.connect(registry_db_path) as conn:
            # Register the public key
            conn.execute('''
                INSERT INTO registered_pubkeys 
                (qnet_pubkey, solana_txid, registration_timestamp, node_type, status)
                VALUES (?, ?, ?, ?, ?)
            ''', (qnet_pubkey, solana_txid, current_timestamp, "light", "active"))
            
            # Register the used Solana transaction
            conn.execute('''
                INSERT INTO used_solana_txids 
                (solana_txid, qnet_pubkey, usage_timestamp, burn_amount, verification_status)
                VALUES (?, ?, ?, ?, ?)
            ''', (solana_txid, qnet_pubkey, current_timestamp, burn_amount, "verified"))
            
            conn.commit()
            
        logger_func.info(f"Successfully registered activation: QNet PubKey {qnet_pubkey[:10]}... with Solana TxID {solana_txid[:10]}...")
        return True
        
    except Exception as e:
        logger_func.error(f"Failed to register activation: {e}")
        return False

@activation_bp.route('/request_activation_token', methods=['POST'])
def request_activation_token():
    app_config = get_config()
    logger = current_app.logger

    logger.debug(f"Request Headers: {request.headers}")
    try:
        raw_body_text = request.get_data(as_text=True)
        logger.debug(f"Request Raw Data: {raw_body_text}")
    except Exception as e_raw:
        logger.warning(f"Could not get raw request body as text: {e_raw}")

    data = request.get_json(silent=True)
    logger.debug(f"Parsed JSON data: {data}")

    if not data:
        logger.error("/request_activation_token - Invalid JSON or empty request body.")
        return jsonify({"error": "Invalid JSON or empty request body"}), 400

    qnet_pubkey = data.get("qnet_pubkey")
    solana_txid = data.get("solana_txid")
    solana_pubkey_user = data.get("solana_pubkey_user")
    solana_signature_user = data.get("solana_signature_user")
    signed_message_user = data.get("signed_message_user")

    logger.debug(f"Extracted qnet_pubkey: {'Present' if qnet_pubkey else 'Missing'}")
    logger.debug(f"Extracted solana_txid: {'Present' if solana_txid else 'Missing'}")
    logger.debug(f"Extracted solana_pubkey_user: {'Present' if solana_pubkey_user else 'Missing'}")
    logger.debug(f"Extracted solana_signature_user is present: {solana_signature_user is not None}")
    logger.debug(f"Extracted signed_message_user: {'Present' if signed_message_user else 'Missing'}")

    if not all([qnet_pubkey, solana_txid, solana_pubkey_user, solana_signature_user, signed_message_user]):
        missing_fields = [
            k for k, v in {
                "qnet_pubkey": qnet_pubkey, "solana_txid": solana_txid,
                "solana_pubkey_user": solana_pubkey_user,
                "solana_signature_user": solana_signature_user,
                "signed_message_user": signed_message_user
            }.items() if not v
        ]
        logger.error(f"Missing required fields: {missing_fields}. Received keys: {list(data.keys()) if isinstance(data, dict) else 'not a dict'}")
        return jsonify({"error": f"Missing required fields. Expecting all of: qnet_pubkey, solana_txid, solana_pubkey_user, solana_signature_user, signed_message_user. Missing: {', '.join(missing_fields)}"}), 400

    logger.info(f"Received activation request for QNet PK: {qnet_pubkey[:10]}..., Solana Tx: {solana_txid[:10]}...")

    # Load configuration values
    solana_rpc_url = app_config.get("Solana", "rpc_url", fallback="https://api.devnet.solana.com")
    qna_mint_address = app_config.get("Token", "qna_mint_address")
    
    # Get dynamic burn requirement based on node type
    node_type = data.get("node_type", "light").lower()
    
    # Import pricing calculator
    try:
        from economics.qna_burn_model import QNABurnCalculator, NodeType
        calculator = QNABurnCalculator()
        
        # TODO: Get actual burn stats from blockchain
        total_burned = 2_500_000_000  # Mock: 25% burned
        
        # Calculate required burn amount
        burn_requirement = calculator.calculate_burn_requirement(
            NodeType(node_type),
            total_burned
        )
        
        if burn_requirement["token"] != "QNA":
            logger.error("Transition to QNC detected but activation bridge only handles QNA")
            return jsonify({"error": "Network has transitioned to QNC. Please use QNC activation."}), 400
            
        # Convert QNA amount to units (with 6 decimals)
        qna_required_units = int(burn_requirement["amount"] * 1_000_000)
        
    except Exception as e:
        logger.error(f"Failed to calculate dynamic burn requirement: {e}")
        # Fallback to config value based on node type
        fallback_map = {
            "light": app_config.getint("Token", "qna_initial_burn_light", fallback=1000000000),
            "full": app_config.getint("Token", "qna_initial_burn_full", fallback=1500000000),
            "super": app_config.getint("Token", "qna_initial_burn_super", fallback=2000000000)
        }
        qna_required_units = fallback_map.get(node_type, 1000000000)
    
    solana_burn_address = app_config.get("Solana", "burn_address")

    # Load issuer keypair automatically
    try:
        if ISSUER_KEY_MANAGER_AVAILABLE:
            config_public_key = app_config.get("Issuer", "public_key_b58")
            config_dir = os.path.join(project_root_bridge, "config")

            issuer_private_key_b58, actual_public_key = get_issuer_keypair(
                config_dir=config_dir,
                config_public_key=config_public_key
            )

            logger.info(f"Issuer keypair loaded automatically. Public key: {actual_public_key}")

        else:
            # Fallback to environment variable
            issuer_private_key_b58 = os.environ.get("ISSUER_PRIVATE_KEY_B58")
            if not issuer_private_key_b58:
                logger.error("CRITICAL: ISSUER_PRIVATE_KEY_B58 environment variable not set and issuer key manager not available.")
                return jsonify({"error": "Issuer key configuration error on server."}), 500
            logger.info("Using issuer key from environment variable")

    except Exception as e:
        logger.error(f"CRITICAL: Failed to load issuer keypair: {e}")
        return jsonify({"error": "Issuer key configuration error on server."}), 500

    # Enhanced check for configuration values after loading them
    logger.debug(f"Config values - qna_mint_address: '{qna_mint_address}'")
    logger.debug(f"Config values - qna_required_units: {qna_required_units} (type: {type(qna_required_units)})")
    logger.debug(f"Config values - solana_burn_address: '{solana_burn_address}'")

    if not all([
        qna_mint_address,
        qna_required_units is not None and isinstance(qna_required_units, int),
        qna_required_units is not None and qna_required_units > 0,
        solana_burn_address
    ]):
        logger.error(
            f"CRITICAL: Token or Solana burn configuration missing or invalid. "
            f"Mint: {qna_mint_address is not None}, RequiredUnits_is_int: {isinstance(qna_required_units, int)}, "
            f"RequiredUnits_value: {qna_required_units}, BurnAddr: {solana_burn_address is not None}"
        )
        return jsonify({"error": "Server token or burn address configuration error (qna_required_units might be missing, not an int, or not > 0)."}), 500

    if not SOLANA_PY_AVAILABLE:
        logger.error("CRITICAL: Solana Python libraries are not available on the server.")
        return jsonify({"error": "Server misconfiguration: Solana library not available."}), 503

    # Create Solana client
    try:
        solana_client = create_solana_client(solana_rpc_url)
    except Exception as e:
        logger.error(f"Cannot create Solana client: {e}")
        return jsonify({"error": f"Cannot create Solana RPC client: {e}"}), 503

    # Verify Solana message signature
    is_solana_sig_valid, sol_sig_reason = verify_solana_message_signature(
        solana_pubkey_user, solana_signature_user, signed_message_user
    )
    if not is_solana_sig_valid:
        logger.warning(f"Solana signature verification failed for {solana_pubkey_user} on tx {solana_txid}: {sol_sig_reason}")
        return jsonify({"error": f"Solana signature verification failed: {sol_sig_reason}"}), 400
    logger.info(f"Solana signature verified for user {solana_pubkey_user}")

    # Verify Solana burn transaction
    is_burn_tx_valid, burn_tx_reason, burn_details = check_solana_burn_tx_details(
        solana_client, solana_txid, solana_pubkey_user,
        qna_mint_address, solana_burn_address, qna_required_units
    )
    if not is_burn_tx_valid:
        logger.warning(f"Solana burn tx {solana_txid} verification failed for {solana_pubkey_user}: {burn_tx_reason}")
        return jsonify({"error": f"Solana burn transaction verification failed: {burn_tx_reason}"}), 400
    logger.info(f"Solana burn tx {solana_txid} verified. Details: {burn_details}")

    # Check QNet registry for uniqueness
    is_qnet_pk_unique, qpk_reason = check_qnet_registry_for_pubkey(qnet_pubkey, app_config)
    if not is_qnet_pk_unique:
        logger.warning(f"QNet PubKey {qnet_pubkey} already registered. Reason: {qpk_reason}")
        return jsonify({"error": f"QNet PubKey check failed: {qpk_reason}"}), 409

    is_sol_txid_unique, stx_reason = check_qnet_registry_for_soltxid(solana_txid, app_config)
    if not is_sol_txid_unique:
        logger.warning(f"Solana TxID {solana_txid} already used. Reason: {stx_reason}")
        return jsonify({"error": f"Solana TxID check failed: {stx_reason}"}), 409
    logger.info(f"QNet registry uniqueness checks passed for QNet PK {qnet_pubkey[:10]} and Solana TxID {solana_txid[:10]}.")

    # Create issuer certificate
    issuer_certificate_payload = {
        "qnet_pubkey": qnet_pubkey,
        "solana_txid": solana_txid,
        "timestamp_issuer": int(time.time())
    }
    certificate_json_str = json.dumps(issuer_certificate_payload, sort_keys=True, separators=(',', ':'))

    # Sign the certificate
    issuer_signature_on_certificate_b58: Optional[str] = None
    mock_issuer_signing_flag = app_config.getboolean("Activation", "mock_issuer_signing", fallback=False)

    try:
        if SOLANA_PY_AVAILABLE and SOLDERS_AVAILABLE:
            issuer_keypair = Keypair.from_base58_string(issuer_private_key_b58)
            signature_solders = issuer_keypair.sign_message(certificate_json_str.encode('utf-8'))
            issuer_signature_on_certificate_b58 = str(signature_solders)
            logger.info("Issuer certificate signed successfully with real keypair")
        else:
            raise ImportError("Solders not available for Keypair signing")

    except Exception as e:
        logger.error(f"Failed to sign issuer certificate with solders: {e}", exc_info=True)
        if mock_issuer_signing_flag:
            issuer_signature_on_certificate_b58 = "mock_signing_error_sig_" + hashlib.sha256(certificate_json_str.encode()).hexdigest()[:16]
            logger.warning("Issuer certificate signing is MOCKED due to error or missing libraries.")
        else:
            return jsonify({"error": "Failed to sign activation certificate due to internal server error."}), 500

    if not issuer_signature_on_certificate_b58:
        logger.error("CRITICAL: Issuer signature is None after signing attempt.")
        if mock_issuer_signing_flag:
            issuer_signature_on_certificate_b58 = "mock_null_signature_fallback_sig_" + hashlib.sha256(certificate_json_str.encode()).hexdigest()[:16]
        else:
            return jsonify({"error": "Critical server error: Failed to produce activation certificate signature."}), 500

    logger.info(f"Issuer certificate signed for QNet PK {qnet_pubkey[:10]}. Signature: {issuer_signature_on_certificate_b58[:10]}...")

    # Create final activation token bundle
    activation_token_bundle = {
        "qnet_pubkey": qnet_pubkey,
        "solana_txid": solana_txid,
        "solana_pubkey_user": solana_pubkey_user,
        "issuer_certificate": issuer_certificate_payload,
        "issuer_signature": issuer_signature_on_certificate_b58,
        "burn_details": burn_details
    }

    # Encode as base64
    activation_token_bundle_json_str = json.dumps(activation_token_bundle, sort_keys=True, separators=(',', ':'))
    activation_token_b64 = base64.b64encode(activation_token_bundle_json_str.encode('utf-8')).decode('utf-8')

    logger.info(f"Activation token generated and ready for QNet PK: {qnet_pubkey[:10]}...")
    logger.info(f"Token length: {len(activation_token_b64)} characters")

    # Return success response with activation token
    return jsonify({
        "success": True,
        "activation_token": activation_token_b64,
        "message": "Activation token generated successfully",
        "details": {
            "qnet_pubkey": qnet_pubkey,
            "solana_txid": solana_txid,
            "verified_burn_amount": burn_details.get('amount_units_transferred') if burn_details else qna_required_units,
            "timestamp": int(time.time())
        }
    })

# Additional helper endpoints for debugging and monitoring

@activation_bp.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for monitoring"""
    app_config = get_config()
    
    health_status = {
        "status": "healthy",
        "timestamp": int(time.time()),
        "services": {
            "solana_py": SOLANA_PY_AVAILABLE,
            "solders": SOLDERS_AVAILABLE,
            "pynacl": PYNACL_AVAILABLE,
            "issuer_key_manager": ISSUER_KEY_MANAGER_AVAILABLE
        },
        "configuration": {
            "solana_rpc": app_config.get("Solana", "rpc_url", fallback="not_configured"),
            "mock_solana_checks": app_config.getboolean("Activation", "mock_solana_checks", fallback=False),
            "mock_issuer_signing": app_config.getboolean("Activation", "mock_issuer_signing", fallback=False),
            "mock_registry_checks": app_config.getboolean("Activation", "mock_qnet_registry_checks", fallback=True)
        }
    }
    
    # Check RPC connectivity if Solana libraries are available
    if SOLANA_PY_AVAILABLE:
        try:
            solana_rpc_url = app_config.get("Solana", "rpc_url", fallback="https://api.devnet.solana.com")
            solana_client = create_solana_client(solana_rpc_url)
            test_response = solana_client.get_latest_blockhash()
            health_status["services"]["solana_rpc"] = "connected"
        except Exception as e:
            health_status["services"]["solana_rpc"] = f"error: {str(e)[:100]}"
    else:
        health_status["services"]["solana_rpc"] = "solana_py_not_available"
    
    return jsonify(health_status)

@activation_bp.route('/config', methods=['GET'])
def get_config_info():
    """Get current configuration (non-sensitive parts only)"""
    app_config = get_config()
    
    config_info = {
        "network": {
            "solana_rpc_url": app_config.get("Solana", "rpc_url", fallback="not_configured"),
            "burn_address": app_config.get("Solana", "burn_address", fallback="not_configured")
        },
        "token": {
            "mint_address": app_config.get("Token", "qna_mint_address", fallback="not_configured"),
            "required_burn_units": app_config.getint("Token", "qna_required_burn_units", fallback=0)
        },
        "activation": {
            "mock_solana_checks": app_config.getboolean("Activation", "mock_solana_checks", fallback=False),
            "mock_issuer_signing": app_config.getboolean("Activation", "mock_issuer_signing", fallback=False),
            "mock_registry_checks": app_config.getboolean("Activation", "mock_qnet_registry_checks", fallback=True)
        },
        "issuer": {
            "public_key": app_config.get("Issuer", "public_key_b58", fallback="not_configured")
        },
        "version_info": {
            "solana_py_available": SOLANA_PY_AVAILABLE,
            "solders_available": SOLDERS_AVAILABLE,
            "pynacl_available": PYNACL_AVAILABLE
        }
    }
    
    return jsonify(config_info)

@activation_bp.route('/test_signature', methods=['POST'])
def test_signature_verification():
    """Test endpoint for signature verification"""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    
    public_key = data.get("public_key")
    signature = data.get("signature")
    message = data.get("message")
    
    if not all([public_key, signature, message]):
        return jsonify({"error": "Missing required fields: public_key, signature, message"}), 400
    
    is_valid, reason = verify_solana_message_signature(public_key, signature, message)
    
    return jsonify({
        "valid": is_valid,
        "reason": reason,
        "message_length": len(message),
        "signature_length": len(signature),
        "public_key_length": len(public_key),
        "libraries": {
            "solana_py": SOLANA_PY_AVAILABLE,
            "solders": SOLDERS_AVAILABLE,
            "pynacl": PYNACL_AVAILABLE
        }
    })

# Error handlers for the activation blueprint
@activation_bp.errorhandler(400)
def activation_handle_bad_request(error):
    """Handle bad request errors for activation endpoints"""
    return jsonify({
        "error": "Bad Request",
        "message": str(error.description) if hasattr(error, 'description') else "Invalid request parameters"
    }), 400

@activation_bp.errorhandler(500)
def activation_handle_internal_error(error):
    """Handle internal server errors for activation endpoints"""
    logger = current_app.logger if current_app else logging.getLogger(__name__)
    logger.error(f"Internal error in activation bridge: {error}")
    return jsonify({
        "error": "Internal Server Error",
        "message": "An internal error occurred while processing the activation request"
    }), 500

@activation_bp.errorhandler(429)
def activation_handle_rate_limit(error):
    """Handle rate limit errors for activation endpoints"""
    return jsonify({
        "error": "Rate Limit Exceeded",
        "message": "Too many activation requests. Please try again later.",
        "retry_after": getattr(error, 'retry_after', 60)
    }), 429