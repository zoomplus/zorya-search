export const SEARCH_SETUP_CAPABILITIES = [
  'project-text',
  'web-read',
  'web-discovery',
  'visual',
  'code-embeddings',
  'project-text-embeddings',
  'jev-classification',
] as const

export type SearchSetupCapability = (typeof SEARCH_SETUP_CAPABILITIES)[number]
export type SearchMcpOperation = 'web' | 'visual' | 'read' | 'classify' | 'index'
export type SearchCapabilityStatus = 'available' | 'not_configured' | 'access_denied'
export type SearchSetupCapabilityField =
  | 'projectText'
  | 'webRead'
  | 'webDiscovery'
  | 'visual'
  | 'embedding'
  | 'projectTextEmbedding'
  | 'classification'

export interface SearchCapabilityAvailability {
  status: SearchCapabilityStatus
  requiredOperations: readonly SearchMcpOperation[]
}

export interface SearchSetupAction {
  commandName: 'zorya-search'
  args: readonly ['configure', '--capability', SearchSetupCapability]
  configScope: 'same-server-profile'
  requiresConsent: true
  secretRequired: boolean
  provider?: 'Brave Search' | 'OpenRouter'
  modelProvider?: 'Voyage' | 'TypeSafe'
  secretEntry?: 'hidden-owner-terminal-or-explicit-env-reference'
}

export interface SearchMcpSetupHint {
  capability: SearchSetupCapability
  requiredGrant: 'web' | 'visual' | 'read' | 'classify'
  requiredOperations: readonly SearchMcpOperation[]
  ownerAction: string
  providerProbe: false
  action: SearchSetupAction
}

interface SearchSetupDescriptor {
  requiredGrant: SearchMcpSetupHint['requiredGrant']
  requiredOperations: readonly SearchMcpOperation[]
  configuredField: SearchSetupCapabilityField
  ownerAction: string
  secretRequired: boolean
  provider?: NonNullable<SearchSetupAction['provider']>
  modelProvider?: NonNullable<SearchSetupAction['modelProvider']>
}

const descriptors = {
  'project-text': { requiredGrant: 'read', requiredOperations: ['read'], configuredField: 'projectText', ownerAction: 'Enable local lexical search of project documentation, rules, and skills.', secretRequired: false },
  'web-read': { requiredGrant: 'web', requiredOperations: ['web'], configuredField: 'webRead', ownerAction: 'Enable reading caller-selected public URLs.', secretRequired: false },
  'web-discovery': { requiredGrant: 'web', requiredOperations: ['web'], configuredField: 'webDiscovery', ownerAction: 'Enable Brave web discovery.', secretRequired: true, provider: 'Brave Search' },
  visual: { requiredGrant: 'visual', requiredOperations: ['visual'], configuredField: 'visual', ownerAction: 'Enable the separate Voyage multimodal visual profile.', secretRequired: true, provider: 'OpenRouter', modelProvider: 'Voyage' },
  'code-embeddings': { requiredGrant: 'read', requiredOperations: ['read'], configuredField: 'embedding', ownerAction: 'Enable the Voyage code embedding profile; lexical retrieval remains available without it.', secretRequired: true, provider: 'OpenRouter', modelProvider: 'Voyage' },
  'project-text-embeddings': { requiredGrant: 'read', requiredOperations: ['read'], configuredField: 'projectTextEmbedding', ownerAction: 'Enable the separate Voyage project-text embedding and reranking profile.', secretRequired: true, provider: 'OpenRouter', modelProvider: 'Voyage' },
  'jev-classification': { requiredGrant: 'classify', requiredOperations: ['classify'], configuredField: 'classification', ownerAction: 'Enable the pinned typesafe/jev-1.14 classification profile.', secretRequired: true, provider: 'OpenRouter', modelProvider: 'TypeSafe' },
} as const satisfies Readonly<Record<SearchSetupCapability, SearchSetupDescriptor>>

export function getSearchCapabilityAvailability(
  operations: ReadonlySet<SearchMcpOperation>,
  configured: Readonly<Record<SearchSetupCapabilityField, boolean>>,
): Readonly<Record<SearchSetupCapability, SearchCapabilityAvailability>> {
  return Object.freeze(Object.fromEntries(SEARCH_SETUP_CAPABILITIES.map((capability) => {
    const descriptor = descriptors[capability]
    const allowed = descriptor.requiredOperations.every((operation) => operations.has(operation))
    return [capability, Object.freeze({
      status: !allowed ? 'access_denied' : configured[descriptor.configuredField] ? 'available' : 'not_configured',
      requiredOperations: descriptor.requiredOperations,
    })]
  })) as unknown as Record<SearchSetupCapability, SearchCapabilityAvailability>)
}

export function getSearchMcpSetupHint(capability: SearchSetupCapability): SearchMcpSetupHint {
  const descriptor = descriptors[capability]
  const provider = 'provider' in descriptor ? descriptor.provider : undefined
  const modelProvider = 'modelProvider' in descriptor ? descriptor.modelProvider : undefined
  const action: SearchSetupAction = Object.freeze({
    commandName: 'zorya-search',
    args: Object.freeze(['configure', '--capability', capability] as const),
    configScope: 'same-server-profile',
    requiresConsent: true,
    secretRequired: descriptor.secretRequired,
    ...(provider ? { provider, secretEntry: 'hidden-owner-terminal-or-explicit-env-reference' as const } : {}),
    ...(modelProvider ? { modelProvider } : {}),
  })
  return Object.freeze({
    capability,
    requiredGrant: descriptor.requiredGrant,
    requiredOperations: descriptor.requiredOperations,
    ownerAction: descriptor.ownerAction,
    providerProbe: false,
    action,
  })
}
