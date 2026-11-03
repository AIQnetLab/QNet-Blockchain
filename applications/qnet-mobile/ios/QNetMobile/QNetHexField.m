/**
 * QNetHexField.m — registers the iOS view of the live field (HexField.swift) with React Native as QNetHexField, the
 * name HexFieldView.js asks for and Android's HexFieldManager (HexField.kt) registers, with the props HexField.js passes.
 */

#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(QNetHexFieldManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(rows, NSInteger)
RCT_EXPORT_VIEW_PROPERTY(live, BOOL)
RCT_EXPORT_VIEW_PROPERTY(rtl, BOOL)
RCT_EXPORT_VIEW_PROPERTY(paper, UIColor)
RCT_EXPORT_VIEW_PROPERTY(signalPale, UIColor)
RCT_EXPORT_VIEW_PROPERTY(signal, UIColor)
RCT_EXPORT_VIEW_PROPERTY(glowColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(glowRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(cellSize, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(glyphSize, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(fontName, NSString)

@end
