import {
	ApolloReducerConfig,
	defaultDataIdFromObject,
	InMemoryCache,
	IntrospectionFragmentMatcher
} from 'apollo-cache-inmemory';
import get from 'lodash/get';

const dataIdFromPath = (result: any, path: string) => {
	if (result.__typename) {
		const id = get(result, path);
		return id ? `${result.__typename}:${id}` : defaultDataIdFromObject(result);
	}
};

const dataIdFromObject = (object: any): string | null | undefined => {
	switch (object.__typename) {
		case 'MailboxMetadata':
			// Identify metadata groups by their section identifier such as
			// `zwc:implicit`.
			return dataIdFromPath(object, 'meta.0.section');
		case 'Folder':
			if (object.id === '1') {
				// Cache the root folder based on both ID and UUID from server
				return `${object.__typename}:${object.id}:${object.uuid}`;
			}
			return defaultDataIdFromObject(object);
		case 'AutoCompleteMatch':
			// AutoCompleteMatch is not guarenteed to have an `id`
			return `${defaultDataIdFromObject(object)}:${object.email}`;
		default:
			return defaultDataIdFromObject(object);
	}
};

function createFragmentMatcher(fragmentMatcherFactory = Object) {
	return new IntrospectionFragmentMatcher(
		fragmentMatcherFactory({
			introspectionQueryResultData: {
				__schema: {
					types: [
						{
							kind: 'INTERFACE',
							name: 'MailItem',
							possibleTypes: [
								{ name: 'Conversation' },
								{ name: 'MessageInfo' },
								{ name: 'MsgWithGroupInfo' }
							]
						}
					]
				}
			}
		})
	);
}

export const CacheType = {
	network: 'NetworkCache',
	local: 'LocalCache'
};

/**
 * Provide a light wrapper over Apollo's inmemory cache with
 * special optimizations for identifying Zimbra object types via
 * `dataIdFromObject`.
 */
export class ZimbraInMemoryCache extends InMemoryCache {
	private _name: string;
	constructor(config: ApolloReducerConfig = {}, name: string) {
		if (name === CacheType.local) {
			super(config);
		} else {
			if (
				!config.fragmentMatcher ||
				typeof config.fragmentMatcher === 'function'
			) {
				config.fragmentMatcher = createFragmentMatcher(config.fragmentMatcher);
			}
			super({
				dataIdFromObject,
				...config
			});
		}

		this._name = name;
	}

	get name() {
		return this._name;
	}
}
