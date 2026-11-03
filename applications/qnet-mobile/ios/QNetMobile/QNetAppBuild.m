/**
 * QNetAppBuild.m — what kind of build this is, under the name and shape of Android's AppBuildModule.kt: `legacyMove`
 * (always NO on iOS), and the app's `version` and `build` number from Info.plist, which its requests name
 * (src/utils/clientAgent.js).
 */

#import <React/RCTBridgeModule.h>

@interface QNetAppBuild : NSObject <RCTBridgeModule>
@end

@implementation QNetAppBuild

RCT_EXPORT_MODULE(QNetAppBuild)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
  NSString *version = info[@"CFBundleShortVersionString"];
  NSString *build = info[@"CFBundleVersion"];
  return @{
    @"legacyMove" : @NO,
    @"version" : [version isKindOfClass:[NSString class]] ? version : @"",
    @"build" : [build isKindOfClass:[NSString class]] ? build : @"",
  };
}

@end
