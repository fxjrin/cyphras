import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useWallet } from '@/context/WalletContext'
import { useNetwork } from '@/context/NetworkContext'
import { useBalances } from '@/hooks/useBalances'
import { useHiddenAssets } from '@/hooks/useHiddenAssets'
import { usePullToPrivate } from '@/hooks/usePullToPrivate'
import { useShieldedAvailable } from '@/hooks/useShieldedAvailable'
import { useShieldedBalances } from '@/hooks/useShieldedBalances'
import { usePreferences } from '@/context/PreferencesContext'
import { Button } from '@/components/ui/button'
import { Layout } from '@/components/Layout'
import { Skeleton } from '@/components/ui/skeleton'
import WalletNavbar from '@/components/WalletNavbar'
import TokenDetailSheet from '@/components/TokenDetailSheet'
import ShieldedReceive from '@/components/ShieldedReceive'
import ShieldedSend, { type ShieldedAction } from '@/components/ShieldedSend'
import ShieldedTokenPicker, { type ShieldedTokenRow } from '@/components/ShieldedTokenPicker'
import ShieldedTokenSheet from '@/components/ShieldedTokenSheet'
import { PrivateModeHint } from '@/components/PrivateModeHint'
import { getIconMap } from '@/hooks/useBalances'
import { Alert } from '@/components/Alert'
import { PhaseBadge } from '@/components/PhaseBadge'
import { DeliveryProgressBar } from '@/components/DeliveryProgressBar'
import { StellarAvatar } from '@/components/StellarAvatar'
import { groupSenderNotes, summarizeSendAmounts } from '@/lib/historyUtils'
import { summarizePhase, aggregatePhase } from '@/lib/phase'
import type { PhaseInfo } from '@/lib/phase'
import type { AssetBalance } from '@/hooks/useBalances'
import { SERVICE_TYPES } from '@constants/services'
import type { PrivateNote, ServiceResponse } from '@ext-types/index'
import {
  RefreshCw,
  Send,
  QrCode,
  History,
  Layers,
  ArrowUpDown,
  MoreHorizontal,
  Copy,
  EyeOff,
  Eye,
  Plus,
  Check,
  X,
  ChevronDown,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react'

// Newest dismissed completion-notice timestamp; only sends newer than this are announced.
const PRIVATE_ACK_KEY = 'cyphras_private_ack'
// One-time flag: the private-mode coach-mark is shown until dismissed or discovered.
const PRIVATE_HINT_KEY = 'cyphras_private_hint_seen'

function XlmIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="76 34 238 238"
      xmlns="http://www.w3.org/2000/svg"
      className="flex-shrink-0"
    >
      <circle cx="195.1" cy="153.1" r="118.9" fill="black" />
      <path
        fill="white"
        d="M164.1,92.3c22.9-11.7,50.4-9.5,71.1,5.6l-1.7,0.9l-11.1,5.7c-17.3-9.7-38.4-9.4-55.5,0.6
 c-17.1,10-27.6,28.3-27.6,48.2c0,2.4,0.2,4.9,0.5,7.3l93.9-47.8l19.4-9.9l22.8-11.6v13.9l-23,11.7l-11.1,5.7l-99,50.4l-5.5,2.8
 l-5.6,2.9l-17.3,8.8v-13.9l5.9-3c4.5-2.3,7.1-7,6.7-12c-0.1-1.7-0.2-3.5-0.2-5.2C126.9,127.5,141.3,104,164.1,92.3z"
      />
      <path
        fill="white"
        d="M275.9,119v13.9l-5.9,3c-4.5,2.3-7.1,7-6.7,12c0.1,1.7,0.2,3.5,0.2,5.2c0,25.7-14.4,49.2-37.3,60.8
 s-50.4,9.5-71.1-5.6l12.1-6.2l0.7-0.4c17.3,9.7,38.5,9.5,55.6-0.5c17.1-10,27.7-28.4,27.7-48.2c0-2.5-0.2-4.9-0.5-7.3l-94,47.9
 l-19.4,9.9l-22.7,11.6v-13.9l22.9-11.7l11.1-5.7L275.9,119z"
      />
    </svg>
  )
}
function AssetIcon({ icon, code }: { icon?: string; code: string }) {
  const [imgError, setImgError] = useState(false)

  if (code === 'XLM') {
    return <XlmIcon />
  }

  if (icon && !imgError) {
    return (
      <img
        src={icon}
        alt={code}
        className="h-8 w-8 rounded-full object-cover flex-shrink-0"
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
      <span className="text-xs font-bold text-muted-foreground">
        {code.slice(0, 2).toUpperCase()}
      </span>
    </div>
  )
}

function BalanceSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <Skeleton className="h-3 w-28 rounded" />
        <Skeleton className="mt-2 h-7 w-32 rounded" />
        <Skeleton className="mt-1.5 h-3 w-24 rounded" />
      </div>

      <div className="grid grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex flex-col items-center gap-2 rounded-xl bg-card py-3">
            <Skeleton className="h-4.5 w-4.5 rounded" />
            <Skeleton className="h-3 w-8 rounded" />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {[1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between rounded-xl bg-card px-4 py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex flex-col gap-1">
                <Skeleton className="h-3.5 w-12 rounded" />
                <Skeleton className="h-3 w-20 rounded" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Skeleton className="h-3.5 w-16 rounded" />
              <Skeleton className="h-3 w-12 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const { status, activePublicKey } = useWallet()
  const { activeNetwork, setActiveNetwork } = useNetwork()
  const {
    balances,
    subentryCount,
    totalUsd,
    dailyChangeUsd,
    dailyChangePct,
    loading,
    error,
    isFunded,
    refresh,
  } = useBalances(status.publicKey)
  const { formatValue, formatPrice, hideBalance, setHideBalance } = usePreferences()
  const { hiddenAssets } = useHiddenAssets(activeNetwork.id, status.publicKey ?? '')
  const { active, showPrivate, exit, handlers, peek, swipe } = usePullToPrivate()
  const {
    available: shieldedAvailable,
    pools: shieldedPools,
    onTestnet: shieldedOnTestnet,
  } = useShieldedAvailable()
  const [switchingNet, setSwitchingNet] = useState(false)
  // Pool the private surfaces act on; clamped to the active network's pool set.
  const [selectedPoolId, setSelectedPoolId] = useState<string>(shieldedPools[0]?.poolId ?? 'xlm')
  const selectedPool =
    shieldedPools.find((p) => p.poolId === selectedPoolId) ?? shieldedPools[0] ?? null
  const poolId = selectedPool?.poolId ?? 'xlm'
  // Scan up front while private mode is merely available so entering it is instant.
  const {
    byPool: shieldedByPool,
    privateTotalUsd,
    privateChangeUsd,
    privateChangePct,
    refresh: refreshShielded,
  } = useShieldedBalances(
    shieldedAvailable,
    activePublicKey,
    activeNetwork.id,
    shieldedPools
  )
  const shieldedBalance = shieldedByPool[poolId]?.balance ?? null
  const shieldedMaxSpendable = shieldedByPool[poolId]?.maxSpendable ?? null
  const shieldedNoteCount = shieldedByPool[poolId]?.noteCount ?? null
  const [shieldedReceiveOpen, setShieldedReceiveOpen] = useState(false)
  const [shieldedAction, setShieldedAction] = useState<ShieldedAction | null>(null)
  // Picker drives send/shield/unshield; tappedPoolId opens the per-token sheet.
  const [pickerAction, setPickerAction] = useState<ShieldedAction | null>(null)
  const [tappedPoolId, setTappedPoolId] = useState<string | null>(null)
  const [shieldedIcons, setShieldedIcons] = useState<Map<string, string>>(new Map())
  // Default seen=true so the coach-mark never flashes before the stored flag loads.
  const [hintSeen, setHintSeen] = useState(true)
  useEffect(() => {
    chrome.storage.local.get(PRIVATE_HINT_KEY, (res) => setHintSeen(!!res[PRIVATE_HINT_KEY]))
  }, [])
  // Opening private mode counts as discovering it, so stop hinting afterward.
  useEffect(() => {
    if (active && !hintSeen) {
      chrome.storage.local.set({ [PRIVATE_HINT_KEY]: true })
      setHintSeen(true)
    }
  }, [active, hintSeen])
  function dismissHint() {
    chrome.storage.local.set({ [PRIVATE_HINT_KEY]: true })
    setHintSeen(true)
  }
  const masked = hideBalance || showPrivate
  const [exitHover, setExitHover] = useState(false)
  const [swiping, setSwiping] = useState(false)
  useEffect(() => {
    if (!active) {
      setExitHover(false)
      setSwiping(false)
      // Reset to the first pool on private-mode exit so re-entering always starts on XLM.
      setSelectedPoolId(shieldedPools[0]?.poolId ?? 'xlm')
      setPickerAction(null)
      setTappedPoolId(null)
    }
  }, [active, shieldedPools])

  useEffect(() => {
    // Keep the selection valid when a network switch changes the pool set.
    if (shieldedPools.length > 0 && !shieldedPools.some((p) => p.poolId === selectedPoolId)) {
      setSelectedPoolId(shieldedPools[0].poolId)
    }
  }, [shieldedPools, selectedPoolId])
  const displayBalances = balances.filter((b) => !hiddenAssets.includes(`${b.code}:${b.issuer}`))
  const [fundingLoading, setFundingLoading] = useState(false)
  const [fundingError, setFundingError] = useState('')
  const [selectedToken, setSelectedToken] = useState<AssetBalance | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notes, setNotes] = useState<PrivateNote[]>([])
  const [progressDismissed, setProgressDismissed] = useState(false)
  const [progressExpanded, setProgressExpanded] = useState(false)
  const [ackAt, setAckAt] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const shieldedMenuRef = useRef<HTMLDivElement>(null)
  const [shieldedMenuOpen, setShieldedMenuOpen] = useState(false)
  const [copiedCy1, setCopiedCy1] = useState(false)
  const [shieldedAddr, setShieldedAddr] = useState<string | null>(null)

  const publicKey = status.publicKey ?? ''

  const formatStroops = (stroops: string, asset: string): string => {
    const decimals = activeNetwork.privateAssets?.find((a) => a.asset === asset)?.decimals ?? 7
    const base = 10n ** BigInt(decimals)
    const v = BigInt(stroops)
    const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return frac ? `${v / base}.${frac}` : (v / base).toString()
  }

  // Group by send (batchId) with the same logic as History, so two sends to the same recipient stay
  // distinct rather than merging on a time window.
  const sendStatus = (() => {
    const batches = groupSenderNotes(notes)
    const inFlight = (s: PrivateNote['status']) =>
      s === 'pending' || s === 'committed' || s === 'scheduled'
    const activeSends: {
      key: string
      recipient: string
      phase: PhaseInfo
      asset: string
      amount: string
      notes: PrivateNote[]
    }[] = []
    let latestDeliveredAt = 0
    for (const b of batches) {
      if (b.some((n) => inFlight(n.status))) {
        const sums = summarizeSendAmounts(b)
        activeSends.push({
          key: b[0].batchId ?? String(b[0].counter),
          recipient: b[0].recipient,
          phase: summarizePhase(b),
          asset: b[0].asset,
          amount: formatStroops(sums.intended.toString(), b[0].asset),
          notes: b,
        })
        continue
      }
      // Only batches fully delivered to the recipient feed the completion notice; a fully recovered send
      // (funds returned to the sender) is not a "complete" delivery and is left to the History row.
      if (b.every((n) => n.status === 'revealed' && !n.recovered)) {
        const at = Math.max(...b.map((n) => n.createdAt ?? 0))
        if (at > latestDeliveredAt) latestDeliveredAt = at
      }
    }
    return { activeSends, latestDeliveredAt }
  })()

  const activeSends = sendStatus.activeSends
  // One active send shows its own phase; several show a per-phase count so sends at different stages
  // are not blended into a single misleading fraction.
  const aggregate =
    activeSends.length === 0
      ? null
      : activeSends.length === 1
        ? activeSends[0].phase
        : aggregatePhase(activeSends.map((s) => s.phase))
  const hasInFlight = activeSends.length > 0
  const activeKeys = activeSends.map((s) => s.key).join(',')

  // Only the most recent undismissed delivered send, and never while a newer send still owns the
  // in-flight card.
  const showComplete =
    !hasInFlight && sendStatus.latestDeliveredAt > 0 && sendStatus.latestDeliveredAt > ackAt

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
      if (shieldedMenuRef.current && !shieldedMenuRef.current.contains(e.target as Node)) {
        setShieldedMenuOpen(false)
      }
    }
    if (menuOpen || shieldedMenuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen, shieldedMenuOpen])

  // Prefetch the cy1 address so the kebab copy writes to the clipboard within the user gesture.
  useEffect(() => {
    if (!shieldedAvailable) {
      setShieldedAddr(null)
      return
    }
    let live = true
    chrome.runtime.sendMessage(
      { type: SERVICE_TYPES.SHIELDED_RECEIVE_ADDRESS },
      (r: ServiceResponse) => {
        if (!live || chrome.runtime.lastError || r?.error) return
        if (r?.shieldedAddress) setShieldedAddr(r.shieldedAddress)
      }
    )
    return () => {
      live = false
    }
  }, [shieldedAvailable, activePublicKey])

  const refreshNotes = useCallback(() => {
    chrome.runtime.sendMessage({ type: SERVICE_TYPES.PRIVATE_LIST_NOTES }, (r: ServiceResponse) => {
      if (Array.isArray(r?.notes)) {
        setNotes(r.notes)
      }
    })
  }, [])

  useEffect(() => {
    chrome.storage.local.get(PRIVATE_ACK_KEY, (res) => {
      setAckAt(typeof res[PRIVATE_ACK_KEY] === 'number' ? res[PRIVATE_ACK_KEY] : 0)
    })
  }, [])

  const dismissComplete = useCallback(() => {
    const at = sendStatus.latestDeliveredAt
    if (at <= 0) return
    setAckAt(at)
    chrome.storage.local.set({ [PRIVATE_ACK_KEY]: at })
  }, [sendStatus.latestDeliveredAt])

  useEffect(() => {
    chrome.runtime.sendMessage({ type: SERVICE_TYPES.PRIVATE_PROCESS_NOTES })
    refreshNotes()
  }, [publicKey, refreshNotes])

  useEffect(() => {
    // Poll only while a send is still in flight; an idle home does no background work.
    if (!hasInFlight) return
    const id = setInterval(() => {
      chrome.runtime.sendMessage({ type: SERVICE_TYPES.PRIVATE_PROCESS_NOTES })
      refreshNotes()
    }, 4000)
    return () => clearInterval(id)
  }, [hasInFlight, refreshNotes])

  useEffect(() => {
    // Re-arm whenever the set of active sends changes, so dismissing one card does not suppress a later
    // send that starts while earlier ones are still in flight.
    setProgressDismissed(false)
  }, [activeKeys])

  useEffect(() => {
    // Repaint when the background processor advances note state, so the card updates without polling.
    if (!publicKey) return
    const noteKey = `cyphras_private_notes_${publicKey}`
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes[noteKey]) refreshNotes()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [publicKey, refreshNotes])

  useEffect(() => {
    // Repaint the private balance when a background spend or scan changes any shielded note store.
    if (!shieldedAvailable || !active) return
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local') return
      if (Object.keys(changes).some((k) => k.startsWith('cyphras_shielded_notes_'))) {
        refreshShielded()
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [shieldedAvailable, active, refreshShielded])

  useEffect(() => {
    // Same issuer-icon source as the public list so private surfaces show the real logo.
    if (!shieldedAvailable) return
    getIconMap(activeNetwork.id).then(setShieldedIcons)
  }, [shieldedAvailable, activeNetwork.id])

  // Force-exit private mode on network or account change so scoped shielded surfaces cannot leak.
  const shieldedScopeGuard = useRef<{ net: string; pk: string } | null>(null)
  useEffect(() => {
    const scope = { net: activeNetwork.id, pk: activePublicKey }
    if (shieldedScopeGuard.current === null) {
      shieldedScopeGuard.current = scope
      return
    }
    if (
      shieldedScopeGuard.current.net === scope.net &&
      shieldedScopeGuard.current.pk === scope.pk
    ) {
      return
    }
    shieldedScopeGuard.current = scope
    setShieldedReceiveOpen(false)
    setShieldedAction(null)
    setPickerAction(null)
    setTappedPoolId(null)
    setSelectedPoolId(shieldedPools[0]?.poolId ?? 'xlm')
    exit()
  }, [activeNetwork.id, activePublicKey, shieldedPools, exit])

  async function handleFundWithFriendbot() {
    if (!status.publicKey || !activeNetwork.friendbotUrl) return
    setFundingLoading(true)
    setFundingError('')
    try {
      const url = `${activeNetwork.friendbotUrl}?addr=${status.publicKey}`
      const res = await fetch(url)
      if (!res.ok) {
        const data = (await res.json()) as { detail?: string }
        if (
          data.detail?.includes('already funded') ||
          data.detail?.includes('createAccountAlreadyExist')
        ) {
          setFundingError('Account already funded')
        } else {
          setFundingError('Funding failed, try again')
        }
      } else {
        await refresh()
      }
    } catch {
      setFundingError('Funding failed, try again')
    } finally {
      setFundingLoading(false)
    }
  }

  function formatBalance(balance: string): string {
    const num = parseFloat(balance)
    if (num === 0) return '0'
    if (num < 0.01) return num.toFixed(7)
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 7 })
  }

  function formatSmall(value: number): string {
    return formatValue(value)
  }

  const shieldedDecimals = selectedPool?.decimals ?? 7
  const shieldedLabel = selectedPool?.label ?? 'XLM'
  // Unshield to a classic asset needs a trustline, proven by a matching balance entry.
  const shieldedHasTrustline =
    !selectedPool ||
    selectedPool.native ||
    balances.some(
      (b) => b.code === selectedPool.assetCode && b.issuer === selectedPool.assetIssuer
    )

  function stroopsToDisplay(stroops: string, decimals: number): string {
    const base = 10n ** BigInt(decimals)
    const v = BigInt(stroops)
    const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return frac ? `${v / base}.${frac}` : (v / base).toString()
  }

  // Native pools use the inline XLM glyph; others reuse the public list's issuer icon.
  function poolIcon(pool: (typeof shieldedPools)[number]): string | undefined {
    if (pool.native) return undefined
    return pool.icon ?? shieldedIcons.get(`${pool.assetCode}:${pool.assetIssuer}`)
  }

  // Per-pool rows for the list and send/unshield pickers, built from the shielded scan.
  const shieldedTokenRows: ShieldedTokenRow[] = shieldedPools.map((pool) => {
    const pb = shieldedByPool[pool.poolId]
    const code = pool.native ? 'XLM' : (pool.assetCode ?? pool.label)
    return {
      poolId: pool.poolId,
      code,
      label: pool.label,
      balance: pb?.balance != null ? stroopsToDisplay(pb.balance, pool.decimals) : '0',
      usdValue: pb?.usdValue ?? null,
      usdPrice: pb?.usdPrice ?? null,
      icon: poolIcon(pool),
    }
  })

  // Shield moves public funds in, so its picker shows each pool's public balance.
  const shieldPickerRows: ShieldedTokenRow[] = shieldedPools.map((pool) => {
    const code = pool.native ? 'XLM' : (pool.assetCode ?? pool.label)
    const match = balances.find((b) =>
      pool.native ? b.isNative : b.code === pool.assetCode && b.issuer === pool.assetIssuer
    )
    return {
      poolId: pool.poolId,
      code,
      label: pool.label,
      balance: match ? formatBalance(match.balance) : '0',
      usdValue: match?.usdValue ?? null,
      icon: poolIcon(pool),
    }
  })

  const pickerRows = pickerAction === 'shield' ? shieldPickerRows : shieldedTokenRows
  const tappedToken = shieldedTokenRows.find((r) => r.poolId === tappedPoolId) ?? null

  function copyPrivateAddress() {
    if (!shieldedAddr) return
    navigator.clipboard.writeText(shieldedAddr)
    setCopiedCy1(true)
    setTimeout(() => setCopiedCy1(false), 2000)
  }

  // Select the pool, then open the shielded send form for the chosen action.
  function openShieldedForPool(targetPoolId: string, nextAction: ShieldedAction) {
    setSelectedPoolId(targetPoolId)
    // Close the picker/tap-sheet as the form opens so the chip's change-asset reopen is clean.
    setPickerAction(null)
    setTappedPoolId(null)
    setShieldedAction(nextAction)
  }

  // The balance card shows the private 24h change in private mode, else the public one.
  const inPrivateCard = showPrivate && shieldedAvailable
  const cardChangeUsd = inPrivateCard ? privateChangeUsd : dailyChangeUsd
  const cardChangePct = inPrivateCard ? privateChangePct : dailyChangePct
  const cardChangeMasked = inPrivateCard ? hideBalance : masked

  return (
    <>
      <Layout
        navbar={<WalletNavbar />}
        bottomBlur={active}
        bottomBlurVisible={exitHover || swiping}
      >
        <div className="flex flex-col gap-4">
          {loading ? (
            <BalanceSkeleton />
          ) : (
            <>
              <div className="peel-wrap">
                <div className="peel-under">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">Private balance</p>
                    <span className="rounded-md p-1 text-muted-foreground">
                      {hideBalance ? <Eye size={14} /> : <EyeOff size={14} />}
                    </span>
                  </div>
                  <p className="mt-1 text-2xl font-bold text-foreground tracking-wider">
                    {hideBalance ? (
                      '******'
                    ) : privateTotalUsd !== null ? (
                      formatSmall(privateTotalUsd)
                    ) : (
                      <span className="inline-block h-7 w-28 animate-pulse rounded bg-muted align-middle" />
                    )}
                  </p>
                  <p
                    className={`mt-0.5 text-xs font-medium ${privateChangeUsd !== null && privateChangeUsd >= 0 ? 'text-green-500' : 'text-destructive'}`}
                  >
                    {!hideBalance && privateChangeUsd !== null && privateChangePct !== null ? (
                      <>
                        {privateChangeUsd >= 0 ? '+' : ''}
                        {formatSmall(privateChangeUsd)} ({privateChangePct >= 0 ? '+' : ''}
                        {privateChangePct.toFixed(2)}%)
                      </>
                    ) : (
                      <span className="invisible">0</span>
                    )}
                  </p>
                </div>
                <div ref={cardRef} className="peel-card rounded-xl bg-card p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {showPrivate ? 'Private balance' : 'Total balance'}
                    </p>
                    <button
                      onClick={() => setHideBalance(!hideBalance)}
                      onPointerDown={(e) => e.stopPropagation()}
                      aria-label={hideBalance ? 'Show balance' : 'Hide balance'}
                      aria-pressed={hideBalance}
                      className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      {hideBalance ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </div>
                  <p className="mt-1 text-2xl font-bold text-foreground tracking-wider">
                    {showPrivate && shieldedAvailable ? (
                      hideBalance ? (
                        '******'
                      ) : privateTotalUsd !== null ? (
                        formatSmall(privateTotalUsd)
                      ) : (
                        <span className="inline-block h-7 w-28 animate-pulse rounded bg-muted align-middle" />
                      )
                    ) : masked ? (
                      '******'
                    ) : totalUsd !== null ? (
                      formatSmall(totalUsd)
                    ) : (
                      <span className="inline-block h-7 w-28 animate-pulse rounded bg-muted align-middle" />
                    )}
                  </p>
                  <p
                    className={`mt-0.5 text-xs font-medium ${cardChangeUsd !== null && cardChangeUsd >= 0 ? 'text-green-500' : 'text-destructive'}`}
                  >
                    {!cardChangeMasked && cardChangeUsd !== null && cardChangePct !== null ? (
                      <>
                        {cardChangeUsd >= 0 ? '+' : ''}
                        {formatSmall(cardChangeUsd)} ({cardChangePct >= 0 ? '+' : ''}
                        {cardChangePct.toFixed(2)}%)
                      </>
                    ) : (
                      <span className="invisible">0</span>
                    )}
                  </p>
                </div>
                {createPortal(<div className="peel-flap" />, document.body)}
                <div
                  className="peel-grab"
                  onPointerDown={handlers.onPointerDown}
                  onPointerMove={handlers.onPointerMove}
                  onPointerUp={handlers.onPointerUp}
                  onPointerCancel={handlers.onPointerUp}
                  onLostPointerCapture={handlers.onPointerUp}
                  onMouseEnter={peek.onMouseEnter}
                  onMouseLeave={peek.onMouseLeave}
                />
              </div>

              {active && shieldedAvailable && (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      {
                        icon: Send,
                        label: 'Send',
                        onClick: () => setPickerAction('send'),
                      },
                      {
                        icon: ArrowDownToLine,
                        label: 'Shield',
                        onClick: () => setPickerAction('shield'),
                      },
                      {
                        icon: ArrowUpFromLine,
                        label: 'Unshield',
                        onClick: () => setPickerAction('unshield'),
                      },
                      {
                        icon: QrCode,
                        label: 'Receive',
                        onClick: () => setShieldedReceiveOpen(true),
                      },
                    ].map(({ icon: Icon, label, onClick }) => (
                      <button
                        key={label}
                        onClick={onClick}
                        className="flex flex-col items-center gap-1.5 rounded-xl bg-card py-3 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                      >
                        <Icon size={18} />
                        <span className="text-xs">{label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between px-1">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Shielded tokens
                      </p>
                      <div className="relative" ref={shieldedMenuRef}>
                        <button
                          onClick={() => setShieldedMenuOpen((o) => !o)}
                          aria-label="Shielded options"
                          aria-expanded={shieldedMenuOpen}
                          className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {shieldedMenuOpen && (
                          <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-xl border border-border bg-background shadow-lg py-1 overflow-hidden">
                            <button
                              className="cursor-pointer flex w-full items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                              onClick={() => {
                                refreshShielded()
                                setShieldedMenuOpen(false)
                              }}
                            >
                              <RefreshCw size={14} className="text-muted-foreground" />
                              Refresh
                            </button>
                            <button
                              disabled={!shieldedAddr}
                              className="cursor-pointer flex w-full items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-muted transition-colors disabled:cursor-default disabled:opacity-50"
                              onClick={copyPrivateAddress}
                            >
                              {copiedCy1 ? (
                                <Check size={14} className="text-muted-foreground" />
                              ) : (
                                <Copy size={14} className="text-muted-foreground" />
                              )}
                              {copiedCy1 ? 'Copied!' : 'Copy private address'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {shieldedTokenRows.map((t) => (
                      <button
                        key={t.poolId}
                        onClick={() => setTappedPoolId(t.poolId)}
                        className="cursor-pointer flex w-full items-center justify-between rounded-xl bg-card px-4 py-3 hover:bg-muted/60 transition-colors text-left"
                      >
                        <div className="flex items-center gap-3">
                          <AssetIcon icon={t.icon} code={t.code} />
                          <div className="flex flex-col">
                            <p className="text-sm font-medium text-foreground">{t.code}</p>
                            <p className="text-xs text-muted-foreground tracking-wider">
                              {hideBalance ? '****' : t.balance}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          {hideBalance ? (
                            <p className="text-sm font-medium text-foreground tracking-wider">
                              ****
                            </p>
                          ) : t.usdValue !== null ? (
                            <p className="text-sm text-foreground">{formatSmall(t.usdValue)}</p>
                          ) : (
                            <p className="text-xs text-muted-foreground">-</p>
                          )}
                          {!hideBalance && t.usdPrice != null && (
                            <p className="text-xs text-muted-foreground">{formatPrice(t.usdPrice)}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {active && !shieldedAvailable && (
                <div className="flex flex-col gap-3 rounded-xl bg-card p-5 text-center">
                  <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/15">
                    <EyeOff size={20} className="text-primary" />
                  </div>
                  {!shieldedOnTestnet ? (
                    <>
                      <p className="text-sm font-medium text-foreground">
                        Private mode runs on testnet
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Switch to the testnet network to shield, send, and receive privately.
                      </p>
                      <Button
                        className="w-full"
                        disabled={switchingNet}
                        onClick={async () => {
                          setSwitchingNet(true)
                          await setActiveNetwork('testnet')
                          setSwitchingNet(false)
                        }}
                      >
                        {switchingNet ? 'Switching...' : 'Switch to testnet'}
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Private mode needs an account created from a recovery phrase.
                    </p>
                  )}
                </div>
              )}

              {!active && (
              <div className="grid grid-cols-4 gap-2">
                {[
                  { icon: Send, label: 'Send', onClick: () => navigate('/send') },
                  { icon: ArrowUpDown, label: 'Swap', onClick: () => navigate('/swap') },
                  { icon: QrCode, label: 'Receive', onClick: () => navigate('/receive') },
                  { icon: History, label: 'History', onClick: () => navigate('/history') },
                ].map(({ icon: Icon, label, onClick }) => (
                  <button
                    key={label}
                    onClick={onClick}
                    className="flex flex-col items-center gap-1.5 rounded-xl bg-card py-3 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                  >
                    <Icon size={18} />
                    <span className="text-xs">{label}</span>
                  </button>
                ))}
              </div>
              )}

              {hasInFlight && !progressDismissed && (
                <div className="rounded-xl bg-card px-4 py-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() =>
                        activeSends.length > 1
                          ? setProgressExpanded((v) => !v)
                          : navigate('/history')
                      }
                      className="cursor-pointer flex flex-1 items-center gap-3 text-left min-w-0"
                    >
                      {activeSends.length === 1 ? (
                        <StellarAvatar publicKey={activeSends[0].recipient} size={32} />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
                          <Send size={16} className="text-primary" />
                        </div>
                      )}
                      <div className="flex flex-1 flex-col gap-1 min-w-0">
                        {activeSends.length > 1 ? (
                          <p className="truncate text-sm font-medium text-foreground">
                            {activeSends.length} private sends
                          </p>
                        ) : (
                          <p className="truncate text-sm font-medium text-foreground tabular-nums">
                            {activeSends[0].amount} {activeSends[0].asset}
                            <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                              to {activeSends[0].recipient.slice(0, 4)}...
                              {activeSends[0].recipient.slice(-4)}
                            </span>
                          </p>
                        )}
                        {aggregate && <PhaseBadge phase={aggregate} />}
                      </div>
                    </button>
                    {activeSends.length > 1 ? (
                      <button
                        onClick={() => setProgressExpanded((v) => !v)}
                        aria-label="Toggle send list"
                        className="cursor-pointer shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <ChevronDown
                          size={16}
                          className={`transition-transform ${progressExpanded ? 'rotate-180' : ''}`}
                        />
                      </button>
                    ) : (
                      <button
                        onClick={() => setProgressDismissed(true)}
                        aria-label="Dismiss private send status"
                        className="cursor-pointer shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {activeSends.length === 1 && (
                    <DeliveryProgressBar
                      key={activeSends[0].key}
                      notes={activeSends[0].notes}
                      className="mt-2.5"
                    />
                  )}
                  {activeSends.length > 1 && progressExpanded && (
                    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                      {activeSends.map((s) => (
                        <button
                          key={s.key}
                          onClick={() => navigate('/history')}
                          className="cursor-pointer flex items-center justify-between gap-2 text-left"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <StellarAvatar publicKey={s.recipient} size={16} />
                            <span className="truncate font-mono text-xs text-foreground">
                              {s.recipient.slice(0, 4)}...{s.recipient.slice(-4)}
                            </span>
                          </div>
                          <PhaseBadge phase={s.phase} size={12} className="shrink-0" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {showComplete && (
                <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3">
                  <button
                    onClick={() => navigate('/history')}
                    className="cursor-pointer flex flex-1 items-center gap-3 text-left min-w-0"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/15">
                      <Check size={18} className="text-green-500" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <p className="text-sm font-medium text-foreground">Private send complete</p>
                      <p className="text-xs text-muted-foreground">
                        Delivered privately, sender and amount stayed hidden
                      </p>
                    </div>
                  </button>
                  <button
                    onClick={dismissComplete}
                    aria-label="Dismiss private send status"
                    className="cursor-pointer shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              {!isFunded && (
                <div className="rounded-xl bg-muted p-4 text-center flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm text-muted-foreground">Account not funded yet</p>
                    <p className="text-xs text-muted-foreground">
                      Send XLM to activate your account
                    </p>
                  </div>
                  {activeNetwork.friendbotUrl && status.publicKey && (
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={fundingLoading}
                      onClick={handleFundWithFriendbot}
                    >
                      {fundingLoading ? 'Funding...' : 'Fund with Friendbot'}
                    </Button>
                  )}
                </div>
              )}

              {!active && isFunded && displayBalances.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between px-1">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Tokens
                    </p>
                    <div className="relative" ref={menuRef}>
                      <button
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="Token options"
                        aria-expanded={menuOpen}
                        className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <MoreHorizontal size={16} />
                      </button>
                      {menuOpen && (
                        <div className="absolute right-0 top-full mt-1 z-30 w-48 rounded-xl border border-border bg-background shadow-lg py-1 overflow-hidden">
                          <button
                            className="cursor-pointer flex w-full items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                            onClick={() => {
                              navigate('/assets/add')
                              setMenuOpen(false)
                            }}
                          >
                            <Plus size={14} className="text-muted-foreground" />
                            Add assets
                          </button>
                          <button
                            className="cursor-pointer flex w-full items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                            onClick={() => {
                              navigate('/assets')
                              setMenuOpen(false)
                            }}
                          >
                            <Layers size={14} className="text-muted-foreground" />
                            Manage tokens
                          </button>
                          <button
                            className="cursor-pointer flex w-full items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                            onClick={() => {
                              refresh()
                              setMenuOpen(false)
                            }}
                          >
                            <RefreshCw size={14} className="text-muted-foreground" />
                            Refresh
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {displayBalances.map((asset) => (
                    <button
                      key={`${asset.code}:${asset.issuer}`}
                      className="cursor-pointer flex w-full items-center justify-between rounded-xl bg-card px-4 py-3 hover:bg-muted/60 transition-colors text-left"
                      onClick={() => setSelectedToken(asset)}
                    >
                      <div className="flex items-center gap-3">
                        <AssetIcon icon={asset.icon} code={asset.code} />
                        <div className="flex flex-col">
                          <p className="text-sm font-medium text-foreground">{asset.code}</p>
                          <p className="text-xs text-muted-foreground tracking-wider">
                            {masked ? '****' : formatBalance(asset.balance)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        {masked ? (
                          <p className="text-sm font-medium text-foreground tracking-wider">****</p>
                        ) : asset.usdValue !== null ? (
                          <p className="text-sm text-foreground">{formatSmall(asset.usdValue)}</p>
                        ) : (
                          <p className="text-xs text-muted-foreground">-</p>
                        )}
                        {asset.usdPrice !== null && (
                          <p className="text-xs text-muted-foreground">
                            {formatPrice(asset.usdPrice)}
                          </p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {fundingError && <p className="text-xs text-destructive text-center">{fundingError}</p>}

          {error && <Alert message={error} onRetry={() => refresh()} retrying={loading} />}
        </div>
        {active && (
          <div
            className="exit-handle"
            onPointerDown={(e) => {
              setSwiping(true)
              swipe.onPointerDown(e)
            }}
            onPointerMove={swipe.onPointerMove}
            onPointerUp={() => {
              setSwiping(false)
              swipe.onPointerUp()
            }}
            onPointerCancel={() => {
              setSwiping(false)
              swipe.onPointerUp()
            }}
            onMouseEnter={() => setExitHover(true)}
            onMouseLeave={() => setExitHover(false)}
          >
            <span className="exit-hint">Swipe up to exit</span>
            <span className="exit-grip" />
          </div>
        )}
      </Layout>

      <TokenDetailSheet
        asset={selectedToken}
        horizonUrl={activeNetwork.horizonUrl}
        onClose={() => setSelectedToken(null)}
      />

      <ShieldedReceive
        open={shieldedReceiveOpen}
        onClose={() => setShieldedReceiveOpen(false)}
      />

      {pickerAction && (
        <ShieldedTokenPicker
          action={pickerAction}
          tokens={pickerRows}
          onSelect={(picked) => openShieldedForPool(picked, pickerAction)}
          onClose={() => setPickerAction(null)}
        />
      )}

      <ShieldedTokenSheet
        token={tappedToken}
        onSend={(picked) => openShieldedForPool(picked, 'send')}
        onReceive={() => setShieldedReceiveOpen(true)}
        onClose={() => setTappedPoolId(null)}
      />

      <ShieldedSend
        action={shieldedAction}
        shieldedBalance={shieldedBalance}
        maxSpendable={shieldedMaxSpendable}
        noteCount={shieldedNoteCount}
        poolId={poolId}
        assetLabel={shieldedLabel}
        decimals={shieldedDecimals}
        assetCode={selectedPool?.assetCode}
        assetIssuer={selectedPool?.assetIssuer}
        assetIcon={selectedPool ? poolIcon(selectedPool) : undefined}
        native={!!selectedPool?.native}
        publicBalance={
          (selectedPool?.native
            ? balances.find((b) => b.isNative)
            : balances.find(
                (b) => b.code === selectedPool?.assetCode && b.issuer === selectedPool?.assetIssuer
              )
          )?.balance ?? null
        }
        subentryCount={subentryCount}
        hasTrustline={shieldedHasTrustline}
        horizonUrl={activeNetwork.horizonUrl}
        networkPassphrase={activeNetwork.passphrase}
        onTrustlineAdded={refresh}
        onChangeAsset={() => {
          // Reopen the picker for the current action so the chip switches pools.
          if (shieldedAction) setPickerAction(shieldedAction)
          setShieldedAction(null)
        }}
        onClose={() => setShieldedAction(null)}
        onDone={refreshShielded}
      />

      {!active && shieldedAvailable && !hintSeen && !loading && (
        <PrivateModeHint targetRef={cardRef} onDismiss={dismissHint} />
      )}
    </>
  )
}
