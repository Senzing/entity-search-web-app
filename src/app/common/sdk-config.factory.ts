import { SzRestConfiguration, SzWebSocketConnectionConfiguration } from '@senzing/sdk-components-ng';

/**
* Pull in api configuration(SzRestConfigurationParameters)
* from: environments/environment
*
* @example
* ng build -c production
* ng serve -c docker
*/
import { apiConfig, pocConfig, environment } from '../../environments/environment';

/**
 * create exportable config factory
 * for AOT compilation.
 *
 * @export
 */
export function SzRestConfigurationFactory() {
  return new SzRestConfiguration( (apiConfig ? apiConfig : undefined) );
}

export function SzPocConfigurationFactory() {
  return new SzWebSocketConnectionConfiguration( (pocConfig ? pocConfig : undefined) )
}