import { useNetwork } from '@/context/NetworkContext'
import { useWallet } from '@/context/WalletContext'
import { TESTNET_PASSPHRASE } from '@constants/networks'
import type { ShieldedConfig } from '@constants/networks'

export interface ShieldedPoolOption {
  poolId: string
  label: string
  decimals: number
  native: boolean
  assetCode?: string
  assetIssuer?: string
  icon?: string
}

interface ShieldedAvailability {
  available: boolean
  pools: ShieldedPoolOption[]
  onTestnet: boolean
}

// Private mode is testnet-only and needs an HD account since shielded spend keys derive from the seed phrase.
export function useShieldedAvailable(): ShieldedAvailability {
  const { activeNetwork } = useNetwork()
  const { accounts, activePublicKey } = useWallet()

  const active = accounts.find((a) => a.publicKey === activePublicKey)
  const isHdAccount = !!active && active.index >= 0 && !active.walletId.startsWith('sk:')

  const shielded = Array.isArray(activeNetwork.shielded) ? activeNetwork.shielded : []
  const onTestnet =
    activeNetwork.id === 'testnet' && activeNetwork.passphrase === TESTNET_PASSPHRASE
  const available = onTestnet && shielded.length > 0 && isHdAccount

  const pools: ShieldedPoolOption[] = shielded.map((p: ShieldedConfig) => ({
    poolId: p.poolId,
    label: p.label,
    decimals: p.decimals,
    native: p.native,
    assetCode: p.assetCode,
    assetIssuer: p.assetIssuer,
    icon: p.icon,
  }))

  return { available, pools, onTestnet }
}
