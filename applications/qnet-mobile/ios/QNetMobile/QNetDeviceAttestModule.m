/**
 * QNetDeviceAttestModule.m — iOS side of the QNetDeviceAttest native module (Android: DeviceAttestModule.kt).
 *
 * The light node's device key (docs/protocols/light-node-messages.md section 5.1): an App Attest key in the Secure
 * Enclave, Apple's attestation of it over a hash the app gives, and its assertions; a DeviceCheck token; and whether
 * this process runs as an iPhone or iPad app on an iPhone or iPad at all. Stateless: the app keeps the key id
 * (JS: NodeDeviceKey.js). Hashes and results cross the bridge as standard base64. The app decides nothing from these; the
 * genesis nodes and the device oracle check them. A development build attests in Apple's sandbox, a TestFlight or
 * App Store build in production.
 *
 * Stable error codes: UNSUPPORTED, INVALID_INPUT, INVALID_KEY (the key is gone: reinstall, restore, offload),
 * SERVER_UNAVAILABLE (try again later with the same key), FAILED.
 */

#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <DeviceCheck/DeviceCheck.h>
#import <objc/message.h>

@interface QNetDeviceAttestModule : NSObject <RCTBridgeModule>
@end

@implementation QNetDeviceAttestModule

RCT_EXPORT_MODULE(QNetDeviceAttest)

+ (BOOL)requiresMainQueueSetup { return NO; }

// UIDevice is read on the main queue; the DeviceCheck calls answer on their own queues.
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

static NSString *QNetAttestCode(NSError *error)
{
  if (![error.domain isEqualToString:DCErrorDomain]) return @"FAILED";
  switch (error.code) {
    case DCErrorFeatureUnsupported: return @"UNSUPPORTED";
    case DCErrorInvalidInput: return @"INVALID_INPUT";
    case DCErrorInvalidKey: return @"INVALID_KEY";
    case DCErrorServerUnavailable: return @"SERVER_UNAVAILABLE";
    default: return @"FAILED";
  }
}

// A 32-byte hash given as base64, or nil.
static NSData *QNetHash(NSString *b64)
{
  if (![b64 isKindOfClass:[NSString class]]) return nil;
  NSData *data = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
  return data.length == 32 ? data : nil;
}

// { attest, deviceCheck, mac, catalyst, vision, simulator, idiom: phone | pad | other }.
RCT_EXPORT_METHOD(environment:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSProcessInfo *info = [NSProcessInfo processInfo];
  // iOS 26.1 and later say whether this is an iPhone or iPad app on Apple Vision Pro; earlier systems cannot run it
  // there with this property, so they answer no.
  BOOL vision = NO;
  SEL onVision = NSSelectorFromString(@"isiOSAppOnVision");
  if ([info respondsToSelector:onVision]) vision = ((BOOL (*)(id, SEL))objc_msgSend)(info, onVision);
  UIUserInterfaceIdiom idiom = [UIDevice currentDevice].userInterfaceIdiom;
  NSString *idiomName = idiom == UIUserInterfaceIdiomPhone ? @"phone" : (idiom == UIUserInterfaceIdiomPad ? @"pad" : @"other");
#if TARGET_OS_SIMULATOR
  BOOL simulator = YES;
#else
  BOOL simulator = NO;
#endif
  resolve(@{
    @"attest": @([[DCAppAttestService sharedService] isSupported]),
    @"deviceCheck": @([[DCDevice currentDevice] isSupported]),
    @"mac": @([info isiOSAppOnMac]),
    @"catalyst": @([info isMacCatalystApp]),
    @"vision": @(vision),
    @"simulator": @(simulator),
    @"idiom": idiomName,
  });
}

// A new App Attest key; resolves its key id (base64 of SHA-256 of the public key). Nothing leaves the device.
RCT_EXPORT_METHOD(generateKey:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[DCAppAttestService sharedService] generateKeyWithCompletionHandler:^(NSString *keyId, NSError *error) {
    if (error || keyId.length == 0) {
      reject(QNetAttestCode(error), @"No App Attest key was made", error);
      return;
    }
    resolve(keyId);
  }];
}

// Apple's attestation object for the key over the hash (one round trip to Apple).
RCT_EXPORT_METHOD(attestKey:(NSString *)keyId
                  clientDataHash:(NSString *)hashB64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *hash = QNetHash(hashB64);
  if (![keyId isKindOfClass:[NSString class]] || keyId.length == 0 || !hash) {
    reject(@"INVALID_INPUT", @"A key id and a 32-byte hash are needed", nil);
    return;
  }
  [[DCAppAttestService sharedService] attestKey:keyId clientDataHash:hash completionHandler:^(NSData *attestation, NSError *error) {
    if (error || attestation.length == 0) {
      reject(QNetAttestCode(error), @"The key was not attested", error);
      return;
    }
    resolve([attestation base64EncodedStringWithOptions:0]);
  }];
}

// The key's assertion over the hash: CBOR { signature, authenticatorData }, made on the device.
RCT_EXPORT_METHOD(generateAssertion:(NSString *)keyId
                  clientDataHash:(NSString *)hashB64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *hash = QNetHash(hashB64);
  if (![keyId isKindOfClass:[NSString class]] || keyId.length == 0 || !hash) {
    reject(@"INVALID_INPUT", @"A key id and a 32-byte hash are needed", nil);
    return;
  }
  [[DCAppAttestService sharedService] generateAssertion:keyId clientDataHash:hash completionHandler:^(NSData *assertion, NSError *error) {
    if (error || assertion.length == 0) {
      reject(QNetAttestCode(error), @"No assertion was made", error);
      return;
    }
    resolve([assertion base64EncodedStringWithOptions:0]);
  }];
}

// A DeviceCheck token for the device oracle (it reads and writes this device's two bits with it).
RCT_EXPORT_METHOD(deviceCheckToken:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  DCDevice *device = [DCDevice currentDevice];
  if (![device isSupported]) {
    reject(@"UNSUPPORTED", @"DeviceCheck is not available here", nil);
    return;
  }
  [device generateTokenWithCompletionHandler:^(NSData *token, NSError *error) {
    if (error || token.length == 0) {
      reject(QNetAttestCode(error), @"No DeviceCheck token", error);
      return;
    }
    resolve([token base64EncodedStringWithOptions:0]);
  }];
}

@end
