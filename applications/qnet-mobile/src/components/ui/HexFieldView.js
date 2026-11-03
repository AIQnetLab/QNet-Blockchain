/**
 * The platform's own view of the live field (QNetHexField), null where the app registers none. A module of its own: a
 * hot update runs the edited module and its importers again, never what it imports, so an edit of HexField.js never
 * asks React Native for the view a second time, which it refuses.
 */
import { UIManager, requireNativeComponent } from 'react-native';

export const NATIVE_VIEW = 'QNetHexField';
export default UIManager.hasViewManagerConfig(NATIVE_VIEW) ? requireNativeComponent(NATIVE_VIEW) : null;
