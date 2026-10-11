import { isIP } from 'node:net'
import { Sandbox } from 'microsandbox'
import type { NetworkPolicy, SandboxBuilder } from 'microsandbox'
import type { NetworkConfig, SandboxConfig } from './core/index.js'

const PYPI_HOSTS = ['pypi.org', 'files.pythonhosted.org']

type Rule = NetworkPolicy['rules'][number]
type Destination = Rule['destination']

// Domain rules can only match once the guest can resolve names.
const DNS_RULE: Rule = {
  direction: 'egress',
  destination: { kind: 'group', group: 'host' },
  protocols: ['udp', 'tcp'],
  ports: [{ start: 53, end: 53 }],
  action: 'allow',
}

function allowEgress(destination: Destination): Rule {
  return { direction: 'egress', destination, protocols: [], ports: [], action: 'allow' }
}

function destination(entry: string): Destination {
  if (entry.includes('/')) return { kind: 'cidr', cidr: entry }
  const ip = isIP(entry)
  if (ip) return { kind: 'cidr', cidr: `${entry}/${ip === 4 ? 32 : 128}` }
  if (entry.startsWith('*.')) return { kind: 'domainSuffix', suffix: entry.slice(2) }
  return { kind: 'domain', domain: entry }
}

function denyByDefault(rules: Rule[]): NetworkPolicy {
  return { defaultEgress: 'deny', defaultIngress: 'allow', rules: [DNS_RULE, ...rules] }
}

/**
 * Turns MST's shorthand into a microsandbox NetworkPolicy; null means no network.
 * Validating the result is left to microsandbox.
 */
function toPolicy(config: SandboxConfig): NetworkPolicy | null {
  const network: NetworkConfig | undefined =
    config.network === true ? 'public' : config.network === false ? 'none' : config.network
  if (network === 'none') return null
  if (network === 'public') return denyByDefault([allowEgress({ kind: 'group', group: 'public' })])
  if (typeof network === 'object' && 'rules' in network) return network

  const hosts = [
    ...new Set([
      ...(network?.allow ?? []),
      ...(config.secrets ?? []).map((s) => s.host),
      ...(config.packages?.length ? PYPI_HOSTS : []),
    ]),
  ]
  return hosts.length ? denyByDefault(hosts.map((h) => allowEgress(destination(h)))) : null
}

export function applyNetwork(builder: SandboxBuilder, config: SandboxConfig): SandboxBuilder {
  const policy = toPolicy(config)
  if (!policy) return builder.disableNetwork()

  // HTTPS domain rules match on the TLS hostname, and secret substitution rewrites
  // requests, so both need microsandbox to terminate TLS on 443.
  const needsTls =
    (config.secrets?.length ?? 0) > 0 ||
    policy.rules.some((r) => r.destination.kind === 'domain' || r.destination.kind === 'domainSuffix')

  return builder.network((n) => {
    const withPolicy = n.policy(policy)
    return needsTls ? withPolicy.tls((t: { interceptedPorts(ports: number[]): unknown }) => t.interceptedPorts([443])) : withPolicy
  })
}

/** Rejects bad network settings before any VM is created. */
export function validateNetwork(config: SandboxConfig) {
  if (toPolicy(config) === null && (config.packages?.length || config.secrets?.length)) {
    throw new Error(
      "[mst] network: 'none' is incompatible with `packages` and `secrets` — " +
        'they require network access. Leave `network` unset to allow only the hosts they need.',
    )
  }
  // microsandbox parses the policy when it is set; the builder is never created.
  try {
    applyNetwork(Sandbox.builder('mst-network-check'), config)
  } catch (err) {
    throw new Error(
      `[mst] Invalid network config ${JSON.stringify(config.network)}: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    )
  }
}
