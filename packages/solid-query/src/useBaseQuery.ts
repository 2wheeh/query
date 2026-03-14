/**
 * Solid v2 PoC — useBaseQuery
 *
 * Architecture: Signal-based subscription (follows TanStack Router pattern)
 *
 * Key design decisions:
 *
 * 1. SIGNAL over STORE for observer result state:
 *    Solid v2's flush order is dirtyQueue (memos) → EFFECT_RENDER → EFFECT_USER.
 *    Store updates from createEffect apply (EFFECT_USER) arrive AFTER memos
 *    recompute, so memos never see the update in the same cycle. Signals solve
 *    this because signal writes schedule a new flush cycle where memos re-evaluate.
 *
 * 2. SYNCHRONOUS initial subscription (before createMemo):
 *    Solid v2's split effect model defers apply callbacks. But when createMemo
 *    returns a pending thenable, <Loading> suspends the subtree — deferred
 *    effects never run. Synchronous subscription avoids this deadlock.
 *
 * 3. setOptions stays in createEffect:
 *    Side effects (fetches, cache mutations) belong in effects, not memos.
 *    setOptions → #notify → subscription fires synchronously inside batch()
 *    → signal write → new flush cycle → memo re-evaluates.
 *
 * 4. Suspension is initial-only:
 *    <Loading> handles first load. Key changes use stale-while-revalidate.
 *    No re-suspension avoids asyncWrite REACTIVE_DIRTY bail-out.
 *
 * Solid v2 API changes applied:
 * - solid-js/store → solid-js (stores merged into main package)
 * - solid-js/web → @solidjs/web
 * - createComputed(on(...)) → createEffect(compute, apply)
 *
 * TODO (requires runtime validation with SolidStart v2):
 * - Verify ssrSource/deferStream + sharedConfig.hydrating cache sync
 * - isPending() / latest() integration for stale-while-revalidate UX
 * - Solid v2 action() bridge for useMutation optimistic updates
 * - Structural sharing via createProjection for fine-grained reactivity
 */
import { shouldThrowError } from '@tanstack/query-core'
import { isServer } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from 'solid-js'
import { useQueryClient } from './QueryClientProvider'
import { useIsRestoring } from './isRestoring'
import type { UseBaseQueryOptions } from './types'
import type { Accessor } from 'solid-js'
import type { QueryClient } from './QueryClient'
import type {
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'

// ------------------------------------------------------------
// useBaseQuery — Solid v2 PoC (signal-based subscription)
// ------------------------------------------------------------
export function useBaseQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  options: Accessor<
    UseBaseQueryOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>
  >,
  Observer: typeof QueryObserver,
  queryClient?: Accessor<QueryClient>,
) {
  const client = createMemo(() => useQueryClient(queryClient?.()))
  const isRestoring = useIsRestoring()

  const defaultedOptions = createMemo(() => {
    const defaultOptions = client().defaultQueryOptions(options())
    defaultOptions._optimisticResults = isRestoring()
      ? 'isRestoring'
      : 'optimistic'
    defaultOptions.structuralSharing = false
    // Enable thenable tracking on observer results — query-core will
    // resolve/reject #currentThenable so we can hand it to Solid v2
    // for suspension without wrapping in createResource.
    defaultOptions.experimental_prefetchInRender = true
    if (isServer) {
      defaultOptions.retry = false
      defaultOptions.throwOnError = true
    }
    return defaultOptions
  })

  // -- Observer lifecycle -----------------------------------------------

  const [observer, setObserver] = createSignal(
    new Observer(client(), defaultedOptions()),
  )

  // Non-reactive snapshot for suspension check (updated by subscription)
  let observerResult = observer().getOptimisticResult(defaultedOptions())

  // Signal-based result state (replaces createStore).
  // Signal writes schedule new flush cycles → memos re-evaluate in dirtyQueue.
  const [result, setResult] =
    createSignal<QueryObserverResult<TData, TError>>(observerResult)

  // -- Subscription ----------------------------------------------------
  //
  // Initial subscription MUST be synchronous (before the suspending createMemo).
  // Solid v2's split effects defer apply callbacks — if createMemo suspends
  // the component via <Loading>, deferred effects never run → deadlock.
  //
  // The subscription callback fires synchronously inside query-core's
  // notifyManager.batch() (queryObserver.ts #notify calls listeners directly,
  // NOT through scheduleFn). So signal writes from the subscription are
  // immediate, scheduling a new flush cycle for memo re-evaluation.

  let currentUnsubscribe: (() => void) | undefined

  function doSubscribe(
    obs: QueryObserver<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ) {
    currentUnsubscribe?.()
    currentUnsubscribe = obs.subscribe((res) => {
      observerResult = res
      setResult(res)
    })
  }

  // Synchronous initial subscription — bridges the suspension gap.
  if (!untrack(isRestoring)) {
    doSubscribe(untrack(observer))
  }
  onCleanup(() => currentUnsubscribe?.())

  // Reactive re-subscription when observer or isRestoring changes.
  // After <Loading> resolves, deferred effects run and this takes over.
  createEffect(
    () => [isRestoring(), observer()] as const,
    ([restoring, obs], prev) => {
      if (restoring) {
        currentUnsubscribe?.()
        currentUnsubscribe = undefined
        return
      }

      doSubscribe(obs)

      // When restoring just finished → sync optimistic result
      const prevRestoring = prev?.[0]
      if (prevRestoring && !isServer) {
        const res = obs.getOptimisticResult(defaultedOptions())
        observerResult = res
        setResult(res)
      }
    },
  )

  // -- Reactive option / client tracking --------------------------------

  // When QueryClient instance changes → new observer
  createEffect(
    () => client(),
    (c, prevC) => {
      if (c !== prevC) {
        setObserver(new Observer(c, defaultedOptions()))
      }
    },
  )

  // When options change → update observer.
  // setOptions → updateResult → #notify → subscription fires synchronously
  // → setResult(signal write) → new flush cycle → memo re-evaluates.
  // No manual setResult needed here — the subscription callback handles it.
  createEffect(
    () => [observer(), defaultedOptions()] as const,
    ([obs, opts], prev) => {
      if (opts !== prev?.[1]) {
        obs.setOptions(opts)
      }
    },
  )

  // -- Suspension -------------------------------------------------------
  //
  // createMemo reads result() signal for reactive dependency tracking.
  // Initial load: returns observer's pending thenable → <Loading> suspends.
  // Key changes: returns stale data → subscription updates signal → memo
  // re-evaluates → new data appears (stale-while-revalidate, no re-suspension).
  //
  // asyncWrite REACTIVE_DIRTY bail-out is avoided because:
  // - Initial load: subscription fires → signal write → memo marked dirty
  //   → asyncWrite bails, BUT signal-triggered memo re-evaluation returns
  //   data (not promise) → <Loading> boundary resolves.
  // - Key changes: hasSuspended=true → never returns promise → no asyncWrite.

  const ssrMemoOptions = {
    ssrSource: options().ssrSource,
    deferStream: options().deferStream,
  }

  let hasSuspended = false

  const data = createMemo(() => {
    const r = result()

    // Suspend ONLY on initial load — never on subsequent key changes.
    // <Loading> handles initial readiness; isPending handles refresh UI.
    if (!hasSuspended && r.status === 'pending' && !isRestoring()) {
      return observerResult.promise
    }
    hasSuspended = true

    // Error boundary support
    if (
      r.isError &&
      !r.isFetching &&
      !isRestoring() &&
      shouldThrowError(observer().options.throwOnError, [
        r.error,
        observer().getCurrentQuery(),
      ])
    ) {
      throw r.error
    }

    return r.data
  }, ssrMemoOptions)

  // -- Return value -----------------------------------------------------
  // Proxy routes `data` access through the suspension-aware memo.
  // All other properties read from the result signal.
  // Stable target object — Proxy is created once per hook instance.

  const proxyTarget = {} as QueryObserverResult<TData, TError>

  const handler = {
    get(
      _target: QueryObserverResult<TData, TError>,
      prop: keyof QueryObserverResult<TData, TError>,
    ): any {
      if (prop === 'data') {
        return data()
      }
      const r = result()
      const value = r[prop]
      return typeof value === 'function' ? value.bind(r) : value
    },
  }

  return new Proxy(proxyTarget, handler)
}
