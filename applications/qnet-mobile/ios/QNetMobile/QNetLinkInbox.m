/**
 * QNetLinkInbox.m — registers the iOS QNetLinkInbox module (LinkInbox.swift) with React Native under the name and
 * shape of Android's (LinkInbox.kt): pending() resolves [{ id, url }], done(id) and note(event, fields) return nothing.
 */

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(QNetLinkInbox, NSObject)

RCT_EXTERN_METHOD(pending:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(done:(nonnull NSNumber *)entry)

RCT_EXTERN_METHOD(note:(nonnull NSString *)event fields:(nonnull NSDictionary *)fields)

@end
