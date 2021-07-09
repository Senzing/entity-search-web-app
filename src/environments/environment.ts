import { SzRestConfigurationParameters, SzWebSocketConnectionParameters } from '@senzing/sdk-components-ng';

// This file can be replaced during build by using the `fileReplacements` array.
// `ng build --prod` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  test: false
};

// api configuration parameters
export const apiConfig: SzRestConfigurationParameters = {
  'basePath': '/api',
  'withCredentials': true
};

export const pocConfig: SzWebSocketConnectionParameters = {
  'hostname': 'localhost',
  'port': 8255,
  'secure': false
};


/** security options for admin area */
//import * as SEC_OPTS from '../../auth/auth.conf.json';
//export const securityConfig = SEC_OPTS;

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
import 'zone.js/dist/zone-error';  // Included with Angular CLI.
