/**
 * QNetSecurityModule.m — iOS side of the QNetSecurity native module (Android: SecurityModule.kt).
 *
 * - Secret screens: while one is shown and the screen is being captured (recording, mirroring, AirPlay) the
 *   window is covered; a screenshot taken on one raises a warning. The app-switcher snapshot is covered by
 *   AppDelegate on every resign-active.
 * - The recovery-phrase field: the pasteboard's change count, and clearing what was copied while it was open.
 * - The recovery phrase's Copy: this device only, expiring after a set time, cleared at once by Delete wallet.
 * - The device seal of a password wallet's wrap: a P-256 key in the Secure Enclave, this device only, usable while it
 *   is unlocked, no user authentication (a device without a passcode has one too); the wrap is sealed to it with ECIES
 *   (AES-GCM), so a copy of the app's files cannot be guessed at off the device (JS: DeviceSecurity IOS_DEVICE_SEALER).
 * - The boot clock for the password lockout and the node's answer rule (with the boot's own id), and a local jailbreak /
 *   hooking check. No network.
 * - The hardware identifier the device's model is named by for a node's binding (JS: DeviceModel).
 * - Deleting or replacing the wallet: the site data web views left in the default web data store (clearWebData).
 */

#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <WebKit/WebKit.h>
#import <mach-o/dyld.h>
#import <CommonCrypto/CommonDigest.h>
#include <time.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>

// The boot this device runs now, named exactly (L-8, as Android's boot count names it): the system's boot session id
// (kern.bootsessionuuid), new at every start and moved by no clock setting, kept only as the first 16 bytes of its
// SHA-256 in hex and never sent. Read once per process, which never outlives its boot; nil where the system gives none.
static NSString *QNetBootId(void)
{
  static NSString *bootId = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    char uuid[64] = {0};
    size_t len = sizeof(uuid) - 1;
    if (sysctlbyname("kern.bootsessionuuid", uuid, &len, NULL, 0) != 0 || uuid[0] == '\0') return;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(uuid, (CC_LONG)strlen(uuid), digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:32];
    for (int i = 0; i < 16; i++) [hex appendFormat:@"%02x", digest[i]];
    bootId = [hex copy];
  });
  return bootId;
}

@interface QNetSecurityModule : NSObject <RCTBridgeModule>
@end

@implementation QNetSecurityModule {
  BOOL _secureOn;
  UIView *_captureCover;
  NSDictionary<NSString *, NSString *> *_texts; // the app's language (setTexts); English until it is set
  NSInteger _secretCopyCount; // the pasteboard's change count after the recovery phrase's Copy; -1 when none
}

RCT_EXPORT_MODULE(QNetSecurity)

+ (BOOL)requiresMainQueueSetup { return YES; }

- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (instancetype)init
{
  if ((self = [super init])) {
    _secretCopyCount = -1;
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector(captureChanged) name:UIScreenCapturedDidChangeNotification object:nil];
    [nc addObserver:self selector:@selector(screenshotTaken) name:UIApplicationUserDidTakeScreenshotNotification object:nil];
  }
  return self;
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (NSString *)text:(NSString *)key fallback:(NSString *)fallback
{
  id value = _texts[key];
  return ([value isKindOfClass:[NSString class]] && [value length] > 0) ? value : fallback;
}

static UIWindow *QNetKeyWindow(void)
{
  for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) return window;
    }
  }
  return [UIApplication sharedApplication].delegate.window;
}

- (void)updateCaptureCover
{
  BOOL show = _secureOn && [UIScreen mainScreen].isCaptured;
  if (show) {
    // The keyboard is drawn in its own window above this cover, and a non-secure field (the recovery phrase)
    // previews every key: editing ends while the screen is captured, and the cover then takes the taps, so no
    // field can be focused again until capture stops (MPLAT-R2-02).
    for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) continue;
      for (UIWindow *w in ((UIWindowScene *)scene).windows) [w endEditing:YES];
    }
  }
  if (show && !_captureCover) {
    UIWindow *window = QNetKeyWindow();
    if (!window) return;
    UIView *cover = [[UIView alloc] initWithFrame:window.bounds];
    cover.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    cover.backgroundColor = [UIColor colorWithRed:17.0/255.0 green:19.0/255.0 blue:31.0/255.0 alpha:1.0];
    UILabel *label = [[UILabel alloc] initWithFrame:CGRectInset(window.bounds, 32, 0)];
    label.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    label.numberOfLines = 0;
    label.textAlignment = NSTextAlignmentCenter;
    label.textColor = [UIColor whiteColor];
    label.text = [self text:@"captureCover" fallback:@"Hidden while the screen is being recorded or shared."];
    [cover addSubview:label];
    [window addSubview:cover];
    _captureCover = cover;
  } else if (!show && _captureCover) {
    [_captureCover removeFromSuperview];
    _captureCover = nil;
  }
}

- (void)captureChanged
{
  dispatch_async(dispatch_get_main_queue(), ^{ [self updateCaptureCover]; });
}

- (void)screenshotTaken
{
  if (!_secureOn) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *root = QNetKeyWindow().rootViewController;
    while (root.presentedViewController) root = root.presentedViewController;
    if (!root) return;
    UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:[self text:@"screenshotTitle" fallback:@"Screenshot taken"]
                       message:[self text:@"screenshotBody" fallback:@"This screen shows secret wallet data. Delete the screenshot from the device's photos and from any cloud backup: anyone who has it controls the wallet."]
                preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:[self text:@"ok" fallback:@"OK"] style:UIAlertActionStyleDefault handler:nil]];
    [root presentViewController:alert animated:YES completion:nil];
  });
}

// The texts this module shows by itself, in the app's language (JS: DeviceSecurity.setNativeTexts).
RCT_EXPORT_METHOD(setTexts:(NSDictionary *)texts)
{
  _texts = [texts isKindOfClass:[NSDictionary class]] ? [texts copy] : nil;
}

RCT_EXPORT_METHOD(setSecureScreen:(BOOL)on)
{
  _secureOn = on;
  [self updateCaptureCover];
}

// The recovery-phrase screen (MPLAT-R3-01): the pasteboard's change count, read without touching its contents, so
// no paste prompt appears. The screen notes it when the phrase field appears.
RCT_EXPORT_METHOD(pasteboardChangeCount:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve(@([UIPasteboard generalPasteboard].changeCount));
}

// When the import ends, whichever way: anything copied since the phrase field appeared (the phrase, from another app
// in Split View or Slide Over) leaves the pasteboard if text is still there. `since` < 0: the count is unknown, so any
// text goes. Nothing is read (hasStrings does not prompt).
RCT_EXPORT_METHOD(clearPasteboardIfChanged:(double)since
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  UIPasteboard *board = [UIPasteboard generalPasteboard];
  BOOL changed = since < 0 || board.changeCount != (NSInteger)since;
  if (changed && board.hasStrings) {
    [board setItems:@[] options:@{}];
    resolve(@YES);
    return;
  }
  resolve(@NO);
}

// The recovery phrase's Copy (an explicit tap): on this device only, never Universal Clipboard, and the pasteboard item
// expires after `seconds`, so the system takes it away while the app is suspended too. Resolves YES once written.
RCT_EXPORT_METHOD(copySecret:(NSString *)text
                  seconds:(double)seconds
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (![text isKindOfClass:[NSString class]] || text.length == 0) {
    resolve(@NO);
    return;
  }
  UIPasteboard *board = [UIPasteboard generalPasteboard];
  NSDictionary *options = @{
    UIPasteboardOptionLocalOnly : @YES,
    UIPasteboardOptionExpirationDate : [NSDate dateWithTimeIntervalSinceNow:MAX(seconds, 0)],
  };
  [board setItems:@[ @{ @"public.utf8-plain-text" : text } ] options:options];
  _secretCopyCount = board.changeCount;
  resolve(@YES);
}

// Delete wallet: the copied phrase leaves the pasteboard now if nothing was copied after it. Nothing is read.
RCT_EXPORT_METHOD(clearSecretCopy:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  UIPasteboard *board = [UIPasteboard generalPasteboard];
  if (_secretCopyCount >= 0 && board.changeCount == _secretCopyCount) [board setItems:@[] options:@{}];
  _secretCopyCount = -1;
  resolve(nil);
}

// A fresh device-owner authentication (Face ID / Touch ID / passcode), with no reuse of an earlier one.
// Independent of the Keychain item, so a wallet whose vault secret is gone can still be erased.
RCT_EXPORT_METHOD(authenticate:(NSString *)reason
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  LAContext *context = [[LAContext alloc] init];
  context.touchIDAuthenticationAllowableReuseDuration = 0;
  NSError *error = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
    resolve(@{ @"ok": @NO, @"code": error.code == LAErrorPasscodeNotSet ? @"not_set" : @"unavailable" });
    return;
  }
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
          localizedReason:reason.length > 0 ? reason : [self text:@"authReason" fallback:@"Confirm it is you"]
                    reply:^(BOOL success, NSError *err) {
    NSString *code = @"ok";
    if (!success) {
      code = (err.code == LAErrorUserCancel || err.code == LAErrorAppCancel || err.code == LAErrorSystemCancel)
        ? @"cancelled" : @"failed";
    }
    resolve(@{ @"ok": @(success), @"code": code });
  }];
}

// ── The Secure Enclave seal ─────────────────────────────────────────────────────────────────────────────────────
static NSString *const QNetSealTag = @"io.aiqnet.wallet.vault-seal.v1";
#define QNET_SEAL_ALGORITHM kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM

static NSData *QNetSealTagData(void)
{
  return [QNetSealTag dataUsingEncoding:NSUTF8StringEncoding];
}

// The seal key (a +1 reference the caller releases), made first when `create` and there is none; NULL with `status`
// set otherwise. A read that fails for another reason never makes a new key: the stored vault may depend on this one.
static SecKeyRef QNetCopySealKey(BOOL create, OSStatus *status)
{
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassKey,
    (__bridge id)kSecAttrKeyClass: (__bridge id)kSecAttrKeyClassPrivate,
    (__bridge id)kSecAttrApplicationTag: QNetSealTagData(),
    (__bridge id)kSecAttrTokenID: (__bridge id)kSecAttrTokenIDSecureEnclave,
    (__bridge id)kSecReturnRef: @YES,
  };
  CFTypeRef found = NULL;
  OSStatus read = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
  if (read == errSecSuccess && found != NULL) return (SecKeyRef)found;
  if (found != NULL) CFRelease(found);
  if (status) *status = read;
  if (read != errSecItemNotFound || !create) return NULL;
  CFErrorRef error = NULL;
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
    kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAccessControlPrivateKeyUsage, &error);
  if (access == NULL) {
    if (error != NULL) CFRelease(error);
    if (status) *status = errSecParam;
    return NULL;
  }
  NSDictionary *attributes = @{
    (__bridge id)kSecAttrKeyType: (__bridge id)kSecAttrKeyTypeECSECPrimeRandom,
    (__bridge id)kSecAttrKeySizeInBits: @256,
    (__bridge id)kSecAttrTokenID: (__bridge id)kSecAttrTokenIDSecureEnclave,
    (__bridge id)kSecPrivateKeyAttrs: @{
      (__bridge id)kSecAttrIsPermanent: @YES,
      (__bridge id)kSecAttrApplicationTag: QNetSealTagData(),
      (__bridge id)kSecAttrAccessControl: (__bridge id)access,
    },
  };
  SecKeyRef key = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attributes, &error);
  CFRelease(access);
  if (key == NULL) {
    if (error != NULL) CFRelease(error);
    if (status) *status = errSecNotAvailable;
  }
  return key;
}

// Whether a password wallet's wrap can be sealed now: a Secure Enclave key exists or could be made (never on a simulator).
RCT_EXPORT_METHOD(hwAvailable:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
#if TARGET_OS_SIMULATOR
  resolve(@NO);
#else
  SecKeyRef key = QNetCopySealKey(YES, NULL);
  if (key != NULL) CFRelease(key);
  resolve(@(key != NULL));
#endif
}

// Seals base64 `data` to the Secure Enclave key's public half (asks nothing): the base64 ECIES ciphertext. Never makes
// the key, as on Android (MA-R2-01): a caller either had hwAvailable make or find it just before (a new or unsealed
// vault), or seals again a vault this key sealed (a data-key or secret rotation).
RCT_EXPORT_METHOD(hwSeal:(NSString *)dataB64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *data = [[NSData alloc] initWithBase64EncodedString:dataB64 options:0];
  if (data == nil) { reject(@"INVALID", @"Not base64", nil); return; }
  OSStatus status = errSecSuccess;
  SecKeyRef key = QNetCopySealKey(NO, &status);
  if (key == NULL) {
    if (status == errSecItemNotFound) reject(@"KEY_MISSING", @"The device seal key is gone", nil);
    else if (status == errSecInteractionNotAllowed) reject(@"DEVICE_LOCKED", @"The device is locked", nil);
    else reject(@"KEYSTORE", @"The device seal key did not answer", nil);
    return;
  }
  SecKeyRef publicKey = SecKeyCopyPublicKey(key);
  CFRelease(key);
  if (publicKey == NULL) { reject(@"KEYSTORE", @"The device seal key has no public half", nil); return; }
  CFErrorRef error = NULL;
  CFDataRef sealed = SecKeyCreateEncryptedData(publicKey, QNET_SEAL_ALGORITHM, (__bridge CFDataRef)data, &error);
  CFRelease(publicKey);
  if (sealed == NULL) {
    if (error != NULL) CFRelease(error);
    reject(@"KEYSTORE", @"The device seal key did not seal", nil);
    return;
  }
  resolve([(__bridge_transfer NSData *)sealed base64EncodedStringWithOptions:0]);
}

// What a failed SecKeyCreateDecryptedData means (MA-R2-03), as Android's errorCode: only an answer that no retry can
// change is permanent. The ECIES step that runs in software refuses a ciphertext this key did not seal (its AES-GCM tag,
// or an ephemeral key or length that does not parse) with errSecParam or errSecDecode, and the Secure Enclave answers
// CryptoTokenKit's corrupted data for input it cannot use: KEY_MISMATCH. A locked device (errSecInteractionNotAllowed,
// CryptoTokenKit's authentication needed) is DEVICE_LOCKED. Anything else (a Secure Enclave that did not answer,
// CryptoTokenKit's communication error, an internal error) is KEYSTORE: the next try may open it.
static NSString *QNetSealOpenErrorCode(CFErrorRef error)
{
  if (error == NULL) return @"KEYSTORE";
  NSString *domain = (__bridge NSString *)CFErrorGetDomain(error);
  CFIndex code = CFErrorGetCode(error);
  if ([domain isEqualToString:@"CryptoTokenKit"]) {
    if (code == -3) return @"KEY_MISMATCH";     // TKErrorCodeCorruptedData
    if (code == -9) return @"DEVICE_LOCKED";    // TKErrorCodeAuthenticationNeeded
    return @"KEYSTORE";
  }
  if ([domain isEqualToString:(__bridge NSString *)kCFErrorDomainOSStatus]) {
    if (code == errSecInteractionNotAllowed) return @"DEVICE_LOCKED";
    if (code == errSecParam || code == errSecDecode) return @"KEY_MISMATCH";
  }
  return @"KEYSTORE";
}

// Opens what hwSeal sealed. KEY_MISSING: the key is gone; KEY_MISMATCH: it is not the key that sealed this;
// DEVICE_LOCKED: the device is locked now; KEYSTORE: the Secure Enclave did not answer. The last two may open next time.
RCT_EXPORT_METHOD(hwOpen:(NSString *)sealedB64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *sealed = [[NSData alloc] initWithBase64EncodedString:sealedB64 options:0];
  if (sealed == nil || sealed.length == 0) { reject(@"SEALED_DAMAGED", @"Not a sealed key", nil); return; }
  OSStatus status = errSecSuccess;
  SecKeyRef key = QNetCopySealKey(NO, &status);
  if (key == NULL) {
    if (status == errSecItemNotFound) reject(@"KEY_MISSING", @"The device seal key is gone", nil);
    else if (status == errSecInteractionNotAllowed) reject(@"DEVICE_LOCKED", @"The device is locked", nil);
    else reject(@"KEYSTORE", @"The device seal key did not answer", nil);
    return;
  }
  CFErrorRef error = NULL;
  CFDataRef plain = SecKeyCreateDecryptedData(key, QNET_SEAL_ALGORITHM, (__bridge CFDataRef)sealed, &error);
  CFRelease(key);
  if (plain == NULL) {
    NSString *code = QNetSealOpenErrorCode(error);
    if (error != NULL) CFRelease(error);
    if ([code isEqualToString:@"DEVICE_LOCKED"]) reject(code, @"The device is locked", nil);
    else if ([code isEqualToString:@"KEY_MISMATCH"]) reject(code, @"The device seal key does not open this", nil);
    else reject(code, @"The device seal key did not answer", nil);
    return;
  }
  resolve([(__bridge_transfer NSData *)plain base64EncodedStringWithOptions:0]);
}

// Part of deleting the wallet: the Secure Enclave key goes.
RCT_EXPORT_METHOD(deleteKeys:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassKey,
    (__bridge id)kSecAttrApplicationTag: QNetSealTagData(),
  };
  SecItemDelete((__bridge CFDictionaryRef)query);
  resolve(nil);
}

RCT_EXPORT_METHOD(bootClock:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts); // counts from boot and keeps counting in sleep; not user-settable
  double mono = (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
  NSMutableDictionary *reading = [@{ @"mono": @(mono), @"wall": @([[NSDate date] timeIntervalSince1970] * 1000.0) } mutableCopy];
  NSString *bootId = QNetBootId();
  if (bootId) reading[@"bootId"] = bootId;
  resolve(reading);
}

// What the JS names the device's model by (DeviceModel.iosModel): the hardware identifier (the simulator's, on the
// simulator) and the interface idiom. No serial, user-given device name or other identifier.
RCT_EXPORT_METHOD(deviceModel:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  struct utsname info;
  NSString *machine = uname(&info) == 0 ? [NSString stringWithUTF8String:info.machine] : @"";
  NSString *simulated = [[NSProcessInfo processInfo] environment][@"SIMULATOR_MODEL_IDENTIFIER"];
  if (simulated.length > 0) machine = simulated;
  UIUserInterfaceIdiom idiom = [UIDevice currentDevice].userInterfaceIdiom;
  NSString *kind = idiom == UIUserInterfaceIdiomPad ? @"pad" : (idiom == UIUserInterfaceIdiomPhone ? @"phone" : @"other");
  resolve(@{ @"machine": machine ?: @"", @"idiom": kind });
}

RCT_EXPORT_METHOD(deviceIntegrity:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSMutableArray *reasons = [NSMutableArray array];
#if !TARGET_OS_SIMULATOR
  NSArray *paths = @[
    @"/Applications/Cydia.app", @"/Applications/Sileo.app", @"/Library/MobileSubstrate/MobileSubstrate.dylib",
    @"/bin/bash", @"/usr/sbin/sshd", @"/etc/apt", @"/private/var/lib/apt", @"/usr/bin/ssh", @"/var/jb",
    @"/private/preboot/jb",
  ];
  NSFileManager *fm = [NSFileManager defaultManager];
  for (NSString *path in paths) {
    if ([fm fileExistsAtPath:path]) { [reasons addObject:@"jailbreak"]; break; }
  }
  NSString *probe = @"/private/qnet_sandbox_probe.txt";
  if ([@"x" writeToFile:probe atomically:YES encoding:NSUTF8StringEncoding error:nil]) {
    [fm removeItemAtPath:probe error:nil];
    [reasons addObject:@"sandbox"];
  }
  uint32_t count = _dyld_image_count();
  for (uint32_t i = 0; i < count; i++) {
    const char *name = _dyld_get_image_name(i);
    if (!name) continue;
    NSString *image = [[NSString stringWithUTF8String:name] lowercaseString];
    if ([image containsString:@"frida"] || [image containsString:@"substrate"] || [image containsString:@"cycript"] ||
        [image containsString:@"libhooker"] || [image containsString:@"tweakinject"] || [image containsString:@"substitute"]) {
      [reasons addObject:@"hook"];
      break;
    }
  }
#endif
  resolve(@{ @"compromised": @(reasons.count > 0), @"reasons": reasons });
}

// Part of deleting or replacing the wallet (L-6), as on Android (SecurityModule.kt clearWebData): every kind of site
// data the default web data store holds goes (cookies, storage, caches). Each browser tab already keeps its own data
// in memory only (webViewEvents.incognitoFor); this clears whatever any other web view left. Resolves YES when done.
RCT_EXPORT_METHOD(clearWebData:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  WKWebsiteDataStore *store = [WKWebsiteDataStore defaultDataStore];
  [store removeDataOfTypes:[WKWebsiteDataStore allWebsiteDataTypes]
             modifiedSince:[NSDate distantPast]
         completionHandler:^{ resolve(@YES); }];
}

@end
