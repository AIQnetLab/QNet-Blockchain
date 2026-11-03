/**
 * QNetNetwork.m — registers the iOS QNetNetwork module (AppNetwork.swift) with React Native under the name and event of
 * Android's (AppNetwork.kt): it emits `qnetNetworkBack` each time a usable network path appears.
 */

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(QNetNetwork, RCTEventEmitter)

@end
