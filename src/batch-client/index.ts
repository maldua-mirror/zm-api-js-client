import DataLoader from 'dataloader';
import castArray from 'lodash/castArray';
import get from 'lodash/get';
import isError from 'lodash/isError';
import mapValues from 'lodash/mapValues';
import { denormalize, normalize } from '../normalize';
import {
	AccountRights,
	ActionOptions as ActionOptionsEntity,
	AddMsgInfo,
	AutoComplete as AutoCompleteEntity,
	AutoCompleteGALResponse,
	AutoCompleteResponse as AutoCompleteResponseEntity,
	CalendarItemCreateModifyRequest,
	CalendarItemDeleteRequest,
	CalendarItemHitInfo,
	ClientInfoResponse,
	Contact,
	Conversation,
	CounterAppointmentInfo,
	CreateAppSpecificPasswordResponse,
	CreateMountpointRequest,
	CreateSignatureRequest,
	DiscoverRightsResponse,
	DocumentActionData,
	Filter,
	Folder,
	ForwardAppointmentInfo,
	ForwardAppointmentInviteInfo,
	FreeBusy,
	FreeBusyInstance,
	GetAppointmentResponse,
	GetDocumentShareURLEntity,
	GetDocumentShareURLResponseEntity,
	GetFolderRequest as GetFolderRequestEntity,
	GetRightsRequest,
	InviteReply,
	MessageInfo,
	SaveDocument,
	SaveDocuments,
	SearchCalendarResourcesResponse,
	SearchResponse,
	SendMessageInfo,
	ShareNotification,
	Tag,
	ZimletConfigEntity
} from '../normalize/entities';
import {
	batchJsonRequest,
	DEFAULT_HOSTNAME,
	DEFAULT_SOAP_PATHNAME,
	jsonRequest
} from '../request';
import {
	JsonRequestOptions,
	Namespace,
	RequestBody,
	RequestOptions
} from '../request/types';
import {
	AddMsgInput,
	CalendarItemInput,
	ClientInfoInput,
	CounterAppointmentInput,
	CreateContactInput,
	CreateIdentityInput,
	CreateMountpointInput,
	CreateTagInput,
	DeleteAppointmentInput,
	DeleteIdentityInput,
	EnableTwoFactorAuthInput,
	ExternalAccountAddInput,
	ExternalAccountImportInput,
	ExternalAccountTestInput,
	FilterInput,
	FolderActionChangeColorInput,
	FolderActionCheckCalendarInput,
	FolderView,
	ForwardAppointmentInput,
	ForwardAppointmentInviteInput,
	GetRightsInput,
	GrantRightsInput,
	InviteReplyInput,
	ModifyContactInput,
	ModifyIdentityInput,
	PreferencesInput,
	RevokeRightsInput,
	SearchFolderInput,
	SendMessageInput,
	ShareNotificationInput,
	SignatureInput,
	WhiteBlackListInput,
	ZimletPreferenceInput
} from '../schema/generated-schema-types';
import {
	coerceBooleanToInt,
	coerceBooleanToString,
	coerceStringToBoolean
} from '../utils/coerce-boolean';
import { mapValuesDeep } from '../utils/map-values-deep';
import {
	normalizeCustomMetaDataAttrs,
	setCustomMetaDataBody
} from '../utils/normalize-attrs-custommetadata';
import { normalizeEmailAddresses } from '../utils/normalize-email-addresses';
import {
	getAttachmentUrl,
	getContactProfileImageUrl,
	getProfileImageUrl,
	normalizeMimeParts
} from '../utils/normalize-mime-parts';
import {
	createContactBody,
	normalizeOtherAttr
} from '../utils/normalize-otherAttribute-contact';
import {
	ActionOptions,
	ActionType,
	ApplyFilterRulesOptions,
	AppointmentOptions,
	AutoCompleteGALOptions,
	AutoCompleteOptions,
	ChangePasswordOptions,
	CreateFolderOptions,
	CreateSearchFolderOptions,
	ExternalAccountDeleteInput,
	ExternalAccountModifyInput,
	FreeBusyOptions,
	GetContactFrequencyOptions,
	GetContactOptions,
	GetConversationOptions,
	GetCustomMetadataOptions,
	GetDocumentShareURLOptions,
	GetFolderOptions,
	GetMailboxMetadataOptions,
	GetMessageOptions,
	GetSMimePublicCertsOptions,
	LoginOptions,
	ModifyProfileImageOptions,
	NoOpOptions,
	RecoverAccountOptions,
	RelatedContactsOptions,
	ResetPasswordOptions,
	SaveDocumentInput,
	SearchCalendarResourcesOptions,
	SearchOptions,
	SessionHandler,
	SetRecoveryAccountOptions,
	ShareInfoOptions,
	WorkingHoursOptions,
	ZimbraClientOptions
} from './types';

import { Notifier } from './notifier';

const DEBUG = false;

function normalizeMessage(
	message: { [key: string]: any },
	{ origin, jwtToken }: { jwtToken?: string; origin?: string }
) {
	const normalizedMessage = normalize(MessageInfo)(message);
	normalizedMessage.attributes =
		normalizedMessage.attributes &&
		mapValuesDeep(normalizedMessage.attributes, coerceStringToBoolean);

	return normalizeEmailAddresses(
		normalizeMimeParts(normalizedMessage, { origin, jwtToken })
	);
}

/**
 * This function is required because the API returns Subfolder data for shared folder
 * with Actual folder path (not mounted folder path). This could lead to 404 "NO SUCH FOLDER EXISTS ERROR".
 */
function updateAbsoluteFolderPath(
	originalName: any,
	parentFolderAbsPath: string,
	folders: any
) {
	return folders.map((folder: any) => {
		// When the entire mailbox is shared with another user, in that case, the originalName would
		// have the value as "USER_ROOT", for that instance we need to append the value to the absFolderPath
		// of the current folder and all children
		if (originalName === 'USER_ROOT') {
			folder.absFolderPath = `${parentFolderAbsPath}${folder.absFolderPath}`;
		} else {
			folder.absFolderPath = folder.absFolderPath.replace(
				`/${originalName}`,
				parentFolderAbsPath
			);
		}

		if (folder.folders) {
			folder.folders = updateAbsoluteFolderPath(
				originalName,
				parentFolderAbsPath,
				folder.folders
			);
		}

		return folder;
	});
}
/**
 * Return an empty string in case it's empty array or null value, else return an Array.
 *
 * Server accepts '' and [] considering following scenarios.
 * 1. 'Single email / folder id' for single item. - Legacy follow this.
 * 2. Array [email, ...] for 1 or more items.
 * 3. '' to set value to empty. (Refer following cases)
 *
 * > [] - No changes to reflect on server.
 * > '' - Set value to empty for given field.
 *
 * So, while submitting data to server, we consider 1st and 2nd case as 1st case only (due to
 * graphQL's single data type limitation). and 3rd case as it is.
 *
 * While retrieving data from Server, it returns,
 * 1. String for single item
 * 2. Array for multiple items
 * 3. '' for empty value
 * So, We convert such item values to array.
 *
 * @param value An Array or empty String
 * @returns Non-empty Array or empty String
 */
function convertStringAndArrayValues(value: any) {
	const result = [].concat(value).filter(Boolean);
	return result.length ? result : '';
}

export class ZimbraBatchClient {
	public notifier: Notifier;
	public origin: string;
	public sessionId: any;
	public soapPathname: string;
	private batchDataLoader: DataLoader<RequestOptions, RequestBody>;
	private csrfToken?: string;
	private dataLoader: DataLoader<RequestOptions, RequestBody>;
	private jwtToken?: string;
	private sessionHandler?: SessionHandler;
	private userAgent?: {};

	constructor(options: ZimbraClientOptions = {}) {
		this.sessionHandler = options.sessionHandler;
		this.userAgent = options.userAgent;
		this.jwtToken = options.jwtToken;
		this.csrfToken = options.csrfToken;
		this.origin =
			options.zimbraOrigin !== undefined
				? options.zimbraOrigin
				: DEFAULT_HOSTNAME;
		this.soapPathname = options.soapPathname || DEFAULT_SOAP_PATHNAME;

		this.notifier = new Notifier();

		// Used for sending batch requests
		this.batchDataLoader = new DataLoader(this.batchDataHandler, {
			cache: false
		});

		// Used for sending individual requests
		this.dataLoader = new DataLoader(this.dataHandler, {
			batch: false,
			cache: false
		});
	}

	public accountInfo = () =>
		this.jsonRequest({
			name: 'GetInfo',
			namespace: Namespace.Account,
			body: {
				sections: 'mbox,attrs,zimlets,props'
			}
		}).then(res => ({
			...res,
			attrs: {
				...mapValuesDeep(res.attrs._attrs, coerceStringToBoolean),
				zimbraMailAlias: [].concat(get(res, 'attrs._attrs.zimbraMailAlias', []))
			},
			...(get(res, 'license.attr') && {
				license: {
					status: res.license.status,
					attr: mapValuesDeep(res.license.attr, coerceStringToBoolean)
				}
			}),
			zimlets: {
				zimlet:
					get(res, 'zimlets.zimlet') &&
					get(res, 'zimlets.zimlet').map(
						({ zimlet, zimletContext, zimletConfig }: any) => ({
							zimlet,
							zimletContext,
							...(zimletConfig && {
								zimletConfig: normalize(ZimletConfigEntity)(zimletConfig)
							})
						})
					)
			}
		}));

	public action = (type: ActionType, options: ActionOptions) => {
		const { ids, id, ...rest } = options;

		return this.jsonRequest({
			name: type,
			body: {
				action: {
					id: id || [ids].join(','),
					...denormalize(ActionOptionsEntity)(rest)
				}
			},
			singleRequest: true
		}).then(Boolean);
	};

	public addExternalAccount = ({
		accountType,
		...accountInfo
	}: ExternalAccountAddInput) =>
		this.jsonRequest({
			name: 'CreateDataSource',
			body: {
				[<string>accountType]: mapValuesDeep(accountInfo, coerceBooleanToString)
			},
			singleRequest: true
		}).then(res => get(res, `${accountType}.0.id`));

	public addMessage = (options: AddMsgInput) => {
		const { folderId, content, meta } = get(options, 'message');
		let flags, tags, tagNames, date;

		try {
			({ flags, tags, tagNames, date } = JSON.parse(meta));
		} catch (err) {}

		return this.jsonRequest({
			name: 'AddMsg',
			body: denormalize(AddMsgInfo)({
				message: {
					folderId,
					content: {
						_content: content
					},
					flags,
					tags,
					tagNames,
					date
				}
			}),
			singleRequest: true
		}).then(normalize(MessageInfo));
	};

	public applyFilterRules = ({ ids, filterRules }: ApplyFilterRulesOptions) =>
		this.jsonRequest({
			name: 'ApplyFilterRules',
			body: {
				filterRules: {
					filterRule: filterRules
				},
				m: {
					ids
				}
			}
		}).then(res => {
			const ids = get(res, 'm[0].ids');
			return ids ? ids.split(',') : [];
		});

	public autoComplete = (options: AutoCompleteOptions) =>
		this.jsonRequest({
			name: 'AutoComplete',
			body: denormalize(AutoCompleteEntity)(options)
		}).then(normalize(AutoCompleteResponseEntity));

	public autoCompleteGAL = (options: AutoCompleteGALOptions) =>
		this.jsonRequest({
			name: 'AutoCompleteGal',
			namespace: Namespace.Account,
			body: options
		}).then(res => normalize(AutoCompleteGALResponse)(res));

	public cancelTask = ({ inviteId }: any) =>
		this.jsonRequest({
			name: 'CancelTask',
			body: {
				comp: '0',
				id: inviteId
			},
			singleRequest: true
		}).then(Boolean);

	public changeFolderColor = ({ id, color }: FolderActionChangeColorInput) =>
		this.action(ActionType.folder, {
			id,
			op: 'color',
			color
		});

	public changePassword = ({
		loginNewPassword,
		password,
		username,
		dryRun = false
	}: ChangePasswordOptions) =>
		this.jsonRequest({
			name: 'ChangePassword',
			namespace: Namespace.Account,
			body: {
				account: {
					by: 'name',
					_content: username
				},
				oldPassword: password,
				password: loginNewPassword,
				dryRun
			},
			singleRequest: true
		});

	public checkCalendar = ({ id, value }: FolderActionCheckCalendarInput) =>
		this.action(ActionType.folder, {
			id,
			op: value ? 'check' : '!check'
		});

	public clientInfo = ({ domain }: ClientInfoInput) =>
		this.jsonRequest({
			name: 'ClientInfo',
			body: {
				domain: [
					{
						by: 'name',
						_content: domain
					}
				]
			},
			singleRequest: true,
			namespace: Namespace.Account
		}).then(res => normalize(ClientInfoResponse)(res));

	public contactAction = (options: ActionOptions) =>
		this.action(ActionType.contact, options);

	public conversationAction = (options: ActionOptions) =>
		this.action(ActionType.conversation, options);

	public counterAppointment = (body: CounterAppointmentInput) =>
		this.jsonRequest({
			name: 'CounterAppointment',
			body: denormalize(CounterAppointmentInfo)(body),
			singleRequest: true
		}).then(Boolean);

	public createAppointment = (
		accountName: string,
		appointment: CalendarItemInput
	) =>
		this.jsonRequest({
			name: 'CreateAppointment',
			body: {
				...denormalize(CalendarItemCreateModifyRequest)(appointment)
			},
			accountName,
			singleRequest: true
		}).then(Boolean);

	public createAppointmentException = (
		accountName: string,
		appointment: CalendarItemInput
	) =>
		this.jsonRequest({
			name: 'CreateAppointmentException',
			body: {
				...denormalize(CalendarItemCreateModifyRequest)(appointment)
			},
			accountName,
			singleRequest: true
		}).then(Boolean);

	public createAppSpecificPassword = (appName: string) =>
		this.jsonRequest({
			name: 'CreateAppSpecificPassword',
			namespace: Namespace.Account,
			body: {
				appName: {
					_content: appName
				}
			},
			singleRequest: true
		}).then(res => normalize(CreateAppSpecificPasswordResponse)(res));

	public createContact = (data: CreateContactInput) =>
		this.jsonRequest({
			name: 'CreateContact',
			body: createContactBody(data),
			singleRequest: true
		}).then(res => normalize(Contact)(normalizeOtherAttr(res.cn)[0]));

	public createFolder = (_options: CreateFolderOptions) => {
		const { flags, fetchIfExists, parentFolderId, ...options } = _options;
		return this.jsonRequest({
			name: 'CreateFolder',
			body: {
				folder: {
					...options,
					f: flags,
					fie: fetchIfExists,
					l: parentFolderId
				}
			},
			singleRequest: true
		}).then(res => normalize(Folder)(res.folder[0]));
	};

	public createIdentity = ({ attrs, ...rest }: CreateIdentityInput) =>
		this.jsonRequest({
			name: 'CreateIdentity',
			namespace: Namespace.Account,
			body: {
				identity: {
					...rest,
					_attrs: {
						...mapValues(attrs, coerceBooleanToString),
						zimbraPrefWhenSentToAddresses: convertStringAndArrayValues(
							get(attrs, 'zimbraPrefWhenSentToAddresses')
						),
						zimbraPrefWhenInFolderIds: convertStringAndArrayValues(
							get(attrs, 'zimbraPrefWhenInFolderIds')
						)
					}
				}
			},
			singleRequest: true
		}).then(res => {
			const mappedResult = mapValuesDeep(res, coerceStringToBoolean);
			const {
				_attrs: {
					zimbraPrefWhenSentToAddresses,
					zimbraPrefWhenInFolderIds,
					...restAttr
				},
				...restIdentityProps
			} = get(mappedResult, 'identity.0');

			return {
				...mappedResult,
				identity: [
					{
						...restIdentityProps,
						_attrs: {
							...restAttr,
							...(zimbraPrefWhenSentToAddresses && {
								zimbraPrefWhenSentToAddresses: []
									.concat(zimbraPrefWhenSentToAddresses)
									.filter(Boolean)
							}),
							...(zimbraPrefWhenInFolderIds && {
								zimbraPrefWhenInFolderIds: []
									.concat(zimbraPrefWhenInFolderIds)
									.filter(Boolean)
							})
						}
					}
				]
			};
		});

	public createMountpoint = (_options: CreateMountpointInput) =>
		this.jsonRequest({
			name: 'CreateMountpoint',
			body: denormalize(CreateMountpointRequest)(_options),
			singleRequest: true
		}).then(Boolean);

	public createSearchFolder = (_options: CreateSearchFolderOptions) => {
		const { parentFolderId, ...options } = _options;
		return this.jsonRequest({
			name: 'CreateSearchFolder',
			body: {
				search: {
					...options,
					l: parentFolderId
				}
			},
			singleRequest: true
		}).then(res => normalize(Folder)(res.search[0]));
	};

	public createSignature = (options: SignatureInput) =>
		this.jsonRequest({
			name: 'CreateSignature',
			namespace: Namespace.Account,
			body: denormalize(CreateSignatureRequest)(options),
			singleRequest: true
		});

	public createTag = (tag: CreateTagInput) =>
		this.jsonRequest({
			name: 'CreateTag',
			body: {
				tag: {
					...tag
				}
			},
			singleRequest: true
		}).then(({ tag = [] }) => normalize(Tag)(tag[0]));

	public createTask = (task: CalendarItemInput) =>
		this.jsonRequest({
			name: 'CreateTask',
			body: {
				...denormalize(CalendarItemCreateModifyRequest)(task)
			},
			singleRequest: true
		}).then(Boolean);

	public declineCounterAppointment = (body: CounterAppointmentInput) =>
		this.jsonRequest({
			name: 'DeclineCounterAppointment',
			body: denormalize(CounterAppointmentInfo)(body),
			singleRequest: true
		}).then(Boolean);

	public deleteAppointment = (appointment: DeleteAppointmentInput) =>
		this.jsonRequest({
			name: 'CancelAppointment',
			body: denormalize(CalendarItemDeleteRequest)(appointment),
			singleRequest: true
		}).then(Boolean);

	public deleteExternalAccount = ({ id }: ExternalAccountDeleteInput) =>
		this.jsonRequest({
			name: 'DeleteDataSource',
			body: {
				dsrc: { id }
			},
			singleRequest: true
		}).then(Boolean);

	public deleteIdentity = (identity: DeleteIdentityInput) =>
		this.jsonRequest({
			name: 'DeleteIdentity',
			namespace: Namespace.Account,
			body: {
				identity
			},
			singleRequest: true
		}).then(Boolean);

	public deleteSignature = (options: SignatureInput) =>
		this.jsonRequest({
			name: 'DeleteSignature',
			namespace: Namespace.Account,
			body: options,
			singleRequest: true
		}).then(Boolean);

	public disableTwoFactorAuth = () =>
		this.jsonRequest({
			name: 'DisableTwoFactorAuth',
			namespace: Namespace.Account,
			singleRequest: true
		}).then(Boolean);

	public discoverRights = () =>
		this.jsonRequest({
			name: 'DiscoverRights',
			namespace: Namespace.Account,
			body: {
				right: [
					{
						_content: 'sendAs'
					},
					{
						_content: 'sendOnBehalfOf'
					}
				]
			}
		}).then(res => normalize(DiscoverRightsResponse)(res));

	public dismissCalendarItem = (appointment: any, task: any) =>
		this.jsonRequest({
			name: 'DismissCalendarItemAlarm',
			body: {
				appt: appointment,
				task
			},
			singleRequest: true
		}).then(Boolean);

	public documentAction = (options: ActionOptions) =>
		this.documentActionResponse(ActionType.document, options);

	public documentActionResponse = (
		type: ActionType,
		options: ActionOptions
	) => {
		const { id, ...rest } = options;

		return this.jsonRequest({
			name: type,
			body: {
				action: {
					id: [id].join(','),
					...denormalize(ActionOptionsEntity)(rest)
				}
			},
			singleRequest: true
		}).then(normalize(DocumentActionData));
	};

	public downloadAttachment = ({ id, part }: any) =>
		this.download({
			url: `/service/home/~/?auth=co&id=${id}&part=${part}`
		}).then(({ content }: any) => ({
			id: `${id}_${part}`,
			content
		}));

	public downloadDocument = ({ id, url }: any) =>
		this.download({ url }).then(({ content }: any) => ({
			id: id,
			content
		}));

	public downloadMessage = ({ id, isSecure }: any) =>
		this.download({ isSecure, url: `/service/home/~/?auth=co&id=${id}` }).then(
			({ content }: any) => ({
				id,
				content
			})
		);

	public enableTwoFactorAuth = ({
		name,
		password,
		authToken,
		twoFactorCode,
		csrfTokenSecured
	}: EnableTwoFactorAuthInput) =>
		this.jsonRequest({
			name: 'EnableTwoFactorAuth',
			body: {
				name: {
					_content: name
				},
				...(password && {
					password: {
						_content: password
					}
				}),
				...(authToken && {
					authToken: {
						_content: authToken
					}
				}),
				...(twoFactorCode && {
					twoFactorCode: {
						_content: twoFactorCode
					}
				}),
				csrfTokenSecured
			},
			namespace: Namespace.Account,
			singleRequest: true
		});

	public folderAction = (options: ActionOptions) =>
		this.action(ActionType.folder, options);

	public forwardAppointment = (body: ForwardAppointmentInput) =>
		this.jsonRequest({
			name: 'ForwardAppointment',
			body: denormalize(ForwardAppointmentInfo)(body),
			singleRequest: true
		}).then(Boolean);

	public forwardAppointmentInvite = (body: ForwardAppointmentInviteInput) =>
		this.jsonRequest({
			name: 'ForwardAppointmentInvite',
			body: denormalize(ForwardAppointmentInviteInfo)(body),
			singleRequest: true
		}).then(Boolean);

	public freeBusy = ({ start, end, names }: FreeBusyOptions) =>
		this.jsonRequest({
			name: 'GetFreeBusy',
			body: {
				s: start,
				e: end,
				name: names.join(',')
			}
		}).then(res => normalize(FreeBusy)(res.usr));

	public generateScratchCodes = (username: String) =>
		this.jsonRequest({
			name: 'GenerateScratchCodes',
			namespace: Namespace.Account,
			body: {
				account: {
					by: 'name',
					_content: username
				}
			},
			singleRequest: true
		});

	public getAppointment = (options: AppointmentOptions) =>
		this.jsonRequest({
			name: 'GetAppointment',
			body: options
		}).then(res => normalize(GetAppointmentResponse)(res));

	public getAppSpecificPasswords = () =>
		this.jsonRequest({
			name: 'GetAppSpecificPasswords',
			namespace: Namespace.Account
		});

	public getAttachmentUrl = (attachment: any) =>
		getAttachmentUrl(attachment, {
			origin: this.origin,
			jwtToken: this.jwtToken
		});

	public getAvailableLocales = () =>
		this.jsonRequest({
			name: 'GetAvailableLocales',
			namespace: Namespace.Account
		}).then(res => res.locale);

	public getContact = ({ id, ids, ...rest }: GetContactOptions) =>
		this.jsonRequest({
			name: 'GetContacts',
			body: {
				cn: {
					id: id || (ids || []).join(',')
				},
				...rest
			}
		}).then(res => normalize(Contact)(normalizeOtherAttr(res.cn)));

	public getContactFrequency = (options: GetContactFrequencyOptions) =>
		this.jsonRequest({
			name: 'GetContactFrequency',
			body: options
		}).then(res => {
			res.data = res.data.map((item: any) => {
				item.by = item.spec[0].range;
				return item;
			});
			return res;
		});

	public getContactProfileImageUrl = (attachment: any) =>
		getContactProfileImageUrl(attachment, {
			origin: this.origin,
			jwtToken: this.jwtToken
		});

	public getConversation = (options: GetConversationOptions) =>
		this.jsonRequest({
			name: 'GetConv',
			body: {
				c: mapValues(options, coerceBooleanToInt)
			}
		}).then(res => {
			const c = normalize(Conversation)(res.c[0]);
			c.messages = c.messages.map(this.normalizeMessage);
			return c;
		});

	public getCustomMetadata = ({ id, section }: GetCustomMetadataOptions) =>
		this.jsonRequest({
			name: 'GetCustomMetadata',
			body: {
				id,
				meta: {
					section
				}
			}
		}).then((res: any) => {
			//ensure _attrs is not undefined in each section to aid graphql reading/writing
			if (res.meta) {
				res.meta = res.meta.map((entry: any) => {
					if (!entry._attrs) {
						entry._attrs = {};
					}
					entry = normalizeCustomMetaDataAttrs(entry);
					return entry;
				});
			}
			return mapValuesDeep(res, coerceStringToBoolean);
		});

	public getDataSources = () =>
		this.jsonRequest({
			name: 'GetDataSources'
		}).then(res => mapValuesDeep(res, coerceStringToBoolean));

	public getDeviceStatus = () =>
		this.jsonRequest({
			name: 'GetDeviceStatus',
			namespace: Namespace.Sync
		}).then(res => get(res, 'device') || []);

	public getDocumentShareURL = (options: GetDocumentShareURLOptions) =>
		this.jsonRequest({
			name: 'GetDocumentShareURL',
			body: denormalize(GetDocumentShareURLEntity)(options),
			singleRequest: true
		}).then(res => normalize(GetDocumentShareURLResponseEntity)(res));

	public getFilterRules = () =>
		this.jsonRequest({
			name: 'GetFilterRules'
		}).then(res =>
			normalize(Filter)(get(res, 'filterRules.0.filterRule') || [])
		);

	public getFolder = (options: GetFolderOptions) => {
		return this.jsonRequest({
			name: 'GetFolder',
			body: denormalize(GetFolderRequestEntity)(options)
		}).then(res => {
			const foldersResponse = normalize(Folder)(res);
			const folders = get(foldersResponse, 'folders.0', {});

			if (folders.linkedFolders) {
				folders.linkedFolders = folders.linkedFolders.map((folder: any) => {
					if (
						!folder.view ||
						folder.view === FolderView.Message ||
						folder.view === FolderView.Contact ||
						folder.view === FolderView.Document
					) {
						const {
							absFolderPath,
							oname,
							folders,
							ownerZimbraId,
							sharedItemId
						} = folder;

						/** changed the id to zimbraId:sharedItemId, which is required while moving contact to shared folder and
						 *  server also returns this id in notfications. The original id is stored in userId.
						 */

						if (folder.view === FolderView.Contact) {
							(folder.userId = folder.id),
								(folder.id = `${ownerZimbraId}:${sharedItemId}`);
						}
						if (oname && folders) {
							folder.folders = updateAbsoluteFolderPath(
								oname,
								absFolderPath,
								folders
							);
						}
					}

					return folder;
				});
			}

			return foldersResponse;
		});
	};

	public getIdentities = () =>
		this.jsonRequest({
			name: 'GetIdentities',
			namespace: Namespace.Account
		}).then(({ identity, ...restResult }: any) => {
			const updatedIdentity: any = identity.map(
				({
					_attrs: {
						zimbraPrefWhenInFolderIds,
						zimbraPrefWhenSentToAddresses,
						...restAttrs
					},
					...restIdentity
				}: any) => ({
					...restIdentity,
					_attrs: {
						...restAttrs,
						// Doesn't required to be converted using `convertStringAndArrayValues` as
						// graphQL expects it to be an array
						zimbraPrefWhenInFolderIds: []
							.concat(zimbraPrefWhenInFolderIds)
							.filter(Boolean),
						zimbraPrefWhenSentToAddresses: []
							.concat(zimbraPrefWhenSentToAddresses)
							.filter(Boolean)
					}
				})
			);

			return mapValuesDeep(
				{
					...restResult,
					identity: updatedIdentity
				},
				coerceStringToBoolean
			);
		});

	public getImportStatus = () =>
		this.jsonRequest({
			name: 'GetImportStatus'
		});

	public getMailboxMetadata = ({ section }: GetMailboxMetadataOptions) =>
		this.jsonRequest({
			name: 'GetMailboxMetadata',
			body: {
				meta: {
					section
				}
			}
		}).then((res: any) => {
			//ensure _attrs is not undefined in each section to aid graphql reading/writing
			res.meta = res.meta.map((entry: any) => {
				if (!entry._attrs) entry._attrs = {};
				return entry;
			});
			return mapValuesDeep(res, coerceStringToBoolean);
		});

	public getMessage = ({
		id,
		html,
		raw,
		header,
		read,
		max,
		ridZ
	}: GetMessageOptions) =>
		this.jsonRequest({
			name: 'GetMsg',
			body: {
				m: {
					id,
					html: html !== false && raw !== true ? 1 : 0,
					header,
					read: read === true ? 1 : undefined,
					// expand available expansions
					needExp: 1,
					neuter: 0,
					// max body length (look for mp.truncated=1)
					max: max || 250000,
					raw: raw ? 1 : 0,
					...(ridZ && { ridZ: ridZ })
				}
			}
		}).then(res => (res && res.m ? this.normalizeMessage(res.m[0]) : null));

	/**
	 * Invokes GetMsgMetadataRequest and fetches the metadata of the messages with specified ids
	 * This api should be used when backend returns all the data necessary to download the
	 * metadata of the messages that are dragged and dropped to local folders by user.
	 * @param {GetMessageOptions} {ids: Array<String>} the ids of the messages to be downloaded
	 *
	 * @memberof ZimbraBatchClient
	 */
	public getMessagesMetadata = ({ ids }: GetMessageOptions) =>
		this.jsonRequest({
			name: 'GetMsgMetadata',
			body: {
				m: {
					ids: ids.join(',')
				}
			}
		}).then(res => res.m.map(this.normalizeMessage));

	public getPreferences = () =>
		this.jsonRequest({
			name: 'GetPrefs',
			namespace: Namespace.Account
		}).then(res => {
			let prefs: any = mapValuesDeep(res._attrs, coerceStringToBoolean);
			prefs.zimbraPrefMailTrustedSenderList =
				typeof prefs.zimbraPrefMailTrustedSenderList === 'string'
					? castArray(prefs.zimbraPrefMailTrustedSenderList)
					: prefs.zimbraPrefMailTrustedSenderList;
			return prefs;
		});

	public getProfileImageUrl = (profileImageId: any) =>
		getProfileImageUrl(profileImageId, {
			origin: this.origin,
			jwtToken: this.jwtToken
		});

	public getRights = (options: GetRightsInput) =>
		this.jsonRequest({
			name: 'GetRights',
			namespace: Namespace.Account,
			body: denormalize(GetRightsRequest)(options)
		}).then(normalize(AccountRights));

	public getScratchCodes = (username: String) =>
		this.jsonRequest({
			name: 'GetScratchCodes',
			namespace: Namespace.Account,
			body: {
				account: {
					by: 'name',
					_content: username
				}
			}
		});

	public getSearchFolder = () =>
		this.jsonRequest({
			name: 'GetSearchFolder'
		}).then((res: any) =>
			res.search ? { folders: normalize(Folder)(res.search) } : {}
		);

	public getSignatures = () =>
		this.jsonRequest({
			name: 'GetSignatures',
			namespace: Namespace.Account
		}).then(res => mapValuesDeep(res, coerceStringToBoolean));

	public getSMimePublicCerts = (options: GetSMimePublicCertsOptions) =>
		this.jsonRequest({
			name: 'GetSMIMEPublicCerts',
			body: {
				store: {
					_content: options.store
				},
				email: {
					_content: options.contactAddr
				}
			},
			namespace: Namespace.Account
		});

	public getTag = () =>
		this.jsonRequest({
			name: 'GetTag',
			namespace: Namespace.Mail
		}).then(({ tag = [] }) => tag.map(normalize(Tag)));

	public getTasks = (options: SearchOptions) =>
		this.jsonRequest({
			name: 'Search',
			body: {
				...options
			}
		}).then(res => {
			if (res.cn) {
				res.cn = normalizeOtherAttr(res.cn);
			}

			const normalized = normalize(SearchResponse)(res);

			return {
				...normalized,
				tasks: normalized.task
					? normalized.task.map(normalize(CalendarItemHitInfo))
					: []
			};
		});

	public getTrustedDevices = () =>
		this.jsonRequest({
			name: 'GetTrustedDevices',
			namespace: Namespace.Account
		});

	public getWhiteBlackList = () =>
		this.jsonRequest({
			name: 'GetWhiteBlackList',
			namespace: Namespace.Account
		});

	public getWorkingHours = ({ start, end, names }: WorkingHoursOptions) =>
		this.jsonRequest({
			name: 'GetWorkingHours',
			body: {
				name: names.join(','),
				...denormalize(FreeBusyInstance)({ start, end })
			}
		}).then(res => normalize(FreeBusy)(res.usr));

	public grantRights = (body: GrantRightsInput) =>
		this.jsonRequest({
			name: 'GrantRights',
			namespace: Namespace.Account,
			body: denormalize(AccountRights)(body)
		}).then(normalize(AccountRights));

	public importExternalAccount = ({
		accountType,
		id
	}: ExternalAccountImportInput) =>
		this.jsonRequest({
			name: 'ImportData',
			body: {
				[<string>accountType]: {
					id
				}
			}
		}).then(Boolean);

	public itemAction = (options: ActionOptions) =>
		this.action(ActionType.item, options);

	public jsonRequest = (options: JsonRequestOptions) =>
		// If account name is present that means we will not be able to batch requests
		this[options.singleRequest ? 'dataLoader' : 'batchDataLoader'].load(
			options
		);

	public login = ({
		username,
		password,
		recoveryCode,
		tokenType,
		persistAuthTokenCookie = true,
		twoFactorCode,
		deviceTrusted,
		csrfTokenSecured
	}: LoginOptions) =>
		this.jsonRequest({
			name: 'Auth',
			singleRequest: true,
			body: {
				tokenType,
				csrfTokenSecured,
				persistAuthTokenCookie,
				account: {
					by: 'name',
					_content: username
				},
				...(password && { password }),
				...(recoveryCode && {
					recoveryCode: {
						verifyAccount: true,
						_content: recoveryCode
					}
				}),
				...(twoFactorCode && { twoFactorCode }),
				...(deviceTrusted && { deviceTrusted })
			},
			namespace: Namespace.Account
		}).then(res => mapValuesDeep(res, coerceStringToBoolean));

	public logout = () =>
		this.jsonRequest({
			name: 'EndSession',
			body: {
				logoff: true
			},
			namespace: Namespace.Account
		}).then(Boolean);

	public messageAction = (options: ActionOptions) =>
		this.action(ActionType.message, options);

	public modifyAppointment = (
		accountName: string,
		appointment: CalendarItemInput
	) =>
		this.jsonRequest({
			name: 'ModifyAppointment',
			body: {
				...denormalize(CalendarItemCreateModifyRequest)(appointment)
			},
			accountName,
			singleRequest: true
		}).then(res => normalize(CalendarItemCreateModifyRequest)(res));

	public modifyContact = (data: ModifyContactInput) =>
		this.jsonRequest({
			name: 'ModifyContact',
			body: createContactBody(data),
			singleRequest: true
		}).then(res => normalize(Contact)(normalizeOtherAttr(res.cn)[0]));

	public modifyExternalAccount = ({
		id,
		type: accountType,
		attrs
	}: ExternalAccountModifyInput) =>
		this.jsonRequest({
			name: 'ModifyDataSource',
			body: {
				[<string>accountType]: {
					id,
					...mapValuesDeep(attrs, coerceBooleanToString)
				}
			},
			singleRequest: true
		}).then(Boolean);

	public modifyFilterRules = (filters: Array<FilterInput>) =>
		this.jsonRequest({
			name: 'ModifyFilterRules',
			body: {
				filterRules: [
					{
						filterRule: denormalize(Filter)(filters)
					}
				]
			},
			singleRequest: true
		}).then(Boolean);

	public modifyIdentity = ({ attrs, ...rest }: ModifyIdentityInput) =>
		this.jsonRequest({
			name: 'ModifyIdentity',
			namespace: Namespace.Account,
			body: {
				identity: {
					...rest,
					_attrs: {
						...mapValues(attrs, coerceBooleanToString),
						zimbraPrefWhenSentToAddresses: convertStringAndArrayValues(
							get(attrs, 'zimbraPrefWhenSentToAddresses')
						),
						zimbraPrefWhenInFolderIds: convertStringAndArrayValues(
							get(attrs, 'zimbraPrefWhenInFolderIds')
						)
					}
				}
			},
			singleRequest: true
		});

	public modifyPrefs = (prefs: PreferencesInput) =>
		this.jsonRequest({
			name: 'ModifyPrefs',
			namespace: Namespace.Account,
			body: {
				_attrs: mapValuesDeep(prefs, coerceBooleanToString)
			},
			singleRequest: true
		}).then(Boolean);

	public modifyProfileImage = ({
		content,
		contentType
	}: ModifyProfileImageOptions) => {
		return this.jsonRequest({
			name: 'ModifyProfileImage',
			body: {
				_content: content
			},
			singleRequest: true,
			headers: {
				'Content-Type': contentType && contentType
			}
		});
	};

	public modifyProps = (props: any) =>
		this.jsonRequest({
			name: 'ModifyProperties',
			namespace: Namespace.Account,
			body: {
				prop: mapValuesDeep(props, coerceBooleanToString)
			},
			singleRequest: true
		}).then(Boolean);

	public modifySearchFolder = (options: SearchFolderInput) =>
		this.jsonRequest({
			name: 'ModifySearchFolder',
			body: options,
			singleRequest: true
		}).then(Boolean);

	public modifySignature = (options: SignatureInput) =>
		this.jsonRequest({
			name: 'ModifySignature',
			namespace: Namespace.Account,
			body: denormalize(CreateSignatureRequest)(options),
			singleRequest: true
		}).then(Boolean);

	public modifyTask = (task: CalendarItemInput) =>
		this.jsonRequest({
			name: 'ModifyTask',
			body: {
				...denormalize(CalendarItemCreateModifyRequest)(task)
			},
			singleRequest: true
		}).then(Boolean);

	public modifyWhiteBlackList = (whiteBlackList: WhiteBlackListInput) =>
		this.jsonRequest({
			name: 'ModifyWhiteBlackList',
			namespace: Namespace.Account,
			body: {
				...whiteBlackList
			},
			singleRequest: true
		}).then(Boolean);

	public modifyZimletPrefs = (zimlet: Array<ZimletPreferenceInput>) =>
		this.jsonRequest({
			name: 'ModifyZimletPrefs',
			namespace: Namespace.Account,
			body: {
				zimlet
			},
			singleRequest: true
		});

	public noop = ({ wait, limitToOneBlocked }: NoOpOptions, fetchOptions: any) =>
		this.jsonRequest({
			name: 'NoOp',
			body: {
				wait,
				limitToOneBlocked
			},
			singleRequest: true,
			fetchOptions
		}).then(resp => resp);

	public recoverAccount = ({ channel, email, op }: RecoverAccountOptions) =>
		this.jsonRequest({
			name: 'RecoverAccount',
			body: {
				channel,
				email,
				op
			}
		});

	public relatedContacts = ({ email }: RelatedContactsOptions) =>
		this.jsonRequest({
			name: 'GetRelatedContacts',
			body: {
				targetContact: {
					cn: email
				}
			}
		}).then(resp => resp.relatedContacts.relatedContact);

	public removeDeviceSync = (deviceId: String) =>
		this.jsonRequest({
			name: 'RemoveDevice',
			namespace: Namespace.Sync,
			body: {
				device: {
					id: deviceId
				}
			}
		});

	public resetPassword = ({ password }: ResetPasswordOptions) =>
		this.jsonRequest({
			name: 'ResetPassword',
			namespace: Namespace.Account,
			body: {
				password
			},
			singleRequest: true
		}).then(() => true);

	public resolve = (path: string) => `${this.origin}${path}`;

	public resumeDeviceSync = (deviceId: String) =>
		this.jsonRequest({
			name: 'ResumeDevice',
			namespace: Namespace.Sync,
			body: {
				device: {
					id: deviceId
				}
			}
		});

	public revokeAppSpecificPassword = (appName: string) =>
		this.jsonRequest({
			name: 'RevokeAppSpecificPassword',
			namespace: Namespace.Account,
			body: {
				appName
			},
			singleRequest: true
		}).then(Boolean);

	public revokeOtherTrustedDevices = () =>
		this.jsonRequest({
			name: 'RevokeOtherTrustedDevices',
			namespace: Namespace.Account,
			singleRequest: true
		}).then(Boolean);

	public revokeRights = (body: RevokeRightsInput) =>
		this.jsonRequest({
			name: 'RevokeRights',
			namespace: Namespace.Account,
			body: denormalize(AccountRights)(body),
			singleRequest: true
		}).then(normalize(AccountRights));

	public revokeTrustedDevice = () =>
		this.jsonRequest({
			name: 'RevokeTrustedDevice',
			namespace: Namespace.Account,
			singleRequest: true
		}).then(Boolean);

	public saveDocument = (document: SaveDocumentInput) =>
		this.jsonRequest({
			name: 'SaveDocument',
			body: denormalize(SaveDocuments)(document),
			singleRequest: true
		}).then(({ doc }) => ({
			document: doc.map((d: any) => normalize(SaveDocument)(d))
		}));

	public saveDraft = (message: SendMessageInput, accountName: string) =>
		this.jsonRequest({
			name: 'SaveDraft',
			body: denormalize(SendMessageInfo)({ message }),
			singleRequest: true,
			accountName
		}).then(({ m: messages }) => ({
			message: messages && messages.map(this.normalizeMessage)
		}));

	public search = (options: SearchOptions) =>
		this.jsonRequest({
			name: 'Search',
			body: {
				...options
			}
		}).then(res => {
			if (res.cn) {
				res.cn = normalizeOtherAttr(res.cn);
			}
			const normalized = normalize(SearchResponse)(res);
			if (normalized.messages) {
				normalized.messages = normalized.messages.map(this.normalizeMessage);
			}
			return normalized;
		});

	public searchCalendarResources = (options: SearchCalendarResourcesOptions) =>
		this.jsonRequest({
			name: 'SearchCalendarResources',
			body: options,
			namespace: Namespace.Account
		}).then(normalize(SearchCalendarResourcesResponse));

	public searchGal = (options: SearchOptions) =>
		this.jsonRequest({
			name: 'SearchGal',
			body: options,
			namespace: Namespace.Account
		}).then(normalize(SearchResponse));

	public sendDeliveryReport = (messageId: string) =>
		this.jsonRequest({
			name: 'SendDeliveryReport',
			body: {
				mid: messageId
			},
			singleRequest: true
		}).then(Boolean);

	public sendInviteReply = (requestOptions: InviteReplyInput) =>
		this.jsonRequest({
			name: 'SendInviteReply',
			body: {
				...denormalize(InviteReply)(requestOptions)
			},
			singleRequest: true
		}).then(res => normalize(CalendarItemHitInfo)(res));

	public sendMessage = (message: SendMessageInput, accountName: string) =>
		this.jsonRequest({
			name: 'SendMsg',
			body: denormalize(SendMessageInfo)({ message }),
			singleRequest: true,
			accountName: accountName
		}).then(normalize(SendMessageInfo));

	public sendShareNotification = (body: ShareNotificationInput) =>
		this.jsonRequest({
			name: 'SendShareNotification',
			body: {
				...denormalize(ShareNotification)(body)
			},
			singleRequest: true
		}).then(Boolean);

	public setCsrfToken = (csrfToken: string) => {
		this.csrfToken = csrfToken;
	};

	public setCustomMetadata = (variables: any) =>
		this.jsonRequest({
			name: 'SetCustomMetadata',
			body: setCustomMetaDataBody(variables.customMetaData)
		}).then(Boolean);

	public setJwtToken = (jwtToken: string) => {
		this.jwtToken = jwtToken;
	};

	public setRecoveryAccount = (options: SetRecoveryAccountOptions) =>
		this.jsonRequest({
			name: 'SetRecoveryAccount',
			body: options,
			singleRequest: true
		}).then(Boolean);

	public setUserAgent = (userAgent: Object) => {
		this.userAgent = userAgent;
	};

	public shareInfo = (options: ShareInfoOptions) =>
		this.jsonRequest({
			name: 'GetShareInfo',
			body: {
				...options,
				_jsns: 'urn:zimbraAccount'
			}
		}).then(res => res.share);

	public snoozeCalendarItem = (appointment: any, task: any) =>
		this.jsonRequest({
			name: 'SnoozeCalendarItemAlarm',
			body: {
				appt: appointment,
				task
			},
			singleRequest: true
		}).then(Boolean);

	public suspendDeviceSync = (deviceId: String) =>
		this.jsonRequest({
			name: 'SuspendDevice',
			namespace: Namespace.Sync,
			body: {
				device: {
					id: deviceId
				}
			}
		});

	public taskFolders = () =>
		this.jsonRequest({
			name: 'GetFolder',
			body: {
				view: FolderView.Task,
				tr: true
			}
		}).then(res => normalize(Folder)(res.folder[0].folder));

	public testExternalAccount = ({
		accountType,
		...accountInfo
	}: ExternalAccountTestInput) =>
		this.jsonRequest({
			name: 'TestDataSource',
			body: {
				[<string>accountType]: mapValuesDeep(accountInfo, coerceBooleanToString)
			},
			singleRequest: true
		}).then(res =>
			mapValuesDeep(get(res, `${accountType}.0`), coerceStringToBoolean)
		);

	public uploadMessage = (message: string): any => {
		const contentDisposition = 'attachment';
		const filename = 'message.eml';
		const contentType = 'message/rfc822';

		return fetch(`${this.origin}/service/upload?fmt=raw`, {
			method: 'POST',
			body: message,
			headers: {
				'Content-Disposition': `${contentDisposition}; filename="${filename}"`,
				'Content-Type': contentType,
				...(this.csrfToken && {
					'X-Zimbra-Csrf-Token': this.csrfToken
				})
			},
			credentials: 'include'
		}).then(response => {
			if (response.ok) {
				return response.text().then(result => {
					if (!result) {
						return null;
					}

					// To parser server response like => 200,'null','d93a252a-603e-4675-9e39-95cebe5a9332:b39a4b7c-9232-4228-9269-aa375bc1df67'
					const [, status = '', err = undefined, aid = ''] =
						result.match(/^([^,]+),([^,]+),'(.*)'/) || [];

					if (err && err !== `'null'`) {
						return null;
					}

					if (+status === 200) {
						return aid;
					}
				});
			}
		});
	};

	private batchDataHandler = (requests: Array<RequestOptions>) =>
		batchJsonRequest({
			requests,
			...this.getAdditionalRequestOptions()
		}).then(response => {
			const sessionId = get(response, 'header.context.session.id');
			const notifications = get(response, 'header.context.notify.0');
			const refresh = get(response, 'header.context.refresh');

			this.checkAndUpdateSessionId(sessionId);

			if (this.notifier) {
				if (notifications) {
					this.notifier.handleNotifications(notifications);
				}

				if (refresh) {
					this.notifier.handleRefresh(refresh);
				}
			}

			return response.requests.map((r, i) => {
				if (DEBUG) {
					console.log(
						`[Batch Client Request] ${requests[i].name}`,
						requests[i].body,
						r
					);
				}
				return isError(r) ? r : r.body;
			});
		});

	private checkAndUpdateSessionId = (sessionId: any) => {
		// Need to save session id in apollo cache for user session management zimlet to stop duplication of sessions data.
		if (sessionId && this.sessionId !== sessionId) {
			this.sessionHandler && this.sessionHandler.writeSessionId(sessionId);
			this.sessionId = sessionId;
		}
	};

	private dataHandler = (requests: Array<JsonRequestOptions>) =>
		jsonRequest({
			...requests[0],
			// check if login request then don't add csrfToken
			...this.getAdditionalRequestOptions(requests[0].name !== 'Auth')
		}).then(response => {
			const sessionId = get(response, 'header.context.session.id');
			const notifications = get(response, 'header.context.notify.0');
			const refresh = get(response, 'header.context.refresh');

			this.checkAndUpdateSessionId(sessionId);

			if (this.notifier) {
				if (notifications) {
					this.notifier.handleNotifications(notifications);
				}

				if (refresh) {
					this.notifier.handleRefresh(refresh);
				}
			}

			return isError(response) ? [response] : [response.body];
		});

	private download = ({ isSecure, url }: any) =>
		fetch(`${this.origin}${url}`, {
			headers: {
				...(isSecure && { 'X-Zimbra-Encoding': 'x-base64' }),
				...(this.csrfToken && {
					'X-Zimbra-Csrf-Token': this.csrfToken
				})
			},
			credentials: 'include'
		}).then(response => {
			if (response.ok) {
				return response.text().then(content => {
					if (!content) {
						return undefined;
					}

					return {
						content
					};
				});
			}
		});

	/**
	 * These options are included on every request.
	 */
	private getAdditionalRequestOptions = (addCsrfToken: Boolean = true) => ({
		jwtToken: this.jwtToken,
		...(addCsrfToken && {
			csrfToken: this.csrfToken
		}),
		sessionId:
			this.sessionId ||
			(this.sessionHandler && this.sessionHandler.readSessionId()),
		origin: this.origin,
		userAgent: this.userAgent,
		...(typeof this.notifier.getSequenceNumber() !== 'undefined' && {
			sessionSeq: this.notifier.getSequenceNumber()
		})
	});

	private normalizeMessage = (message: any) =>
		normalizeMessage(message, {
			origin: this.origin,
			jwtToken: this.jwtToken
		});
}
