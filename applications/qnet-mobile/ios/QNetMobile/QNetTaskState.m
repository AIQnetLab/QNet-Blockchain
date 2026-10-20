/**
 * QNetTaskState.m — registers the iOS QNetTaskState module (TaskState.swift) with React Native under the name and
 * shape of Android's (TaskState.kt): closedByUser() resolves a Boolean.
 */

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(QNetTaskState, NSObject)

RCT_EXTERN_METHOD(closedByUser:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
