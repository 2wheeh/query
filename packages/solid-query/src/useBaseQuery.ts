/**
 * Solid v2 PoC — useBaseQuery
 *
 * Key architectural changes from v1 adapter:
 *
 * REMOVED:
 * - createResource + Promise wrapping (Solid v2 createMemo handles async natively)
 * - createDeepSignal hack (was needed to bridge createResource ↔ createStore)
 * - createServerSubscriber / createClientSubscriber split
 * - resolver + unsubscribeQueued race condition handling
 * - hydratableObserverResult + onHydrated SSR workaround
 * - createComputed / on() (removed in Solid v2)
 *
 * ADDED:
 * - Suspension via createMemo returning observer's pending thenable
 *   (query-core's pendingThenable() is a real Promise → passes Solid v2's
 *    `instanceof Promise` check → triggers NotReadyError → <Loading> catches)
 *
 * KEPT:
 * - query-core's state machine (QueryObserver) — unchanged
 * - createStore for reactive result propagation
 * - reconcileFn for structural sharing
 * - Proxy for data access (simplified: routes to suspension-aware memo)
 *
 * Solid v2 API changes applied:
 * - solid-js/store → solid-js (stores merged into main package)
 * - solid-js/web → @solidjs/web
 * - unwrap() → snapshot()
 * - createComputed(on(...)) → createEffect(compute, apply)
 * - on() helper removed — use createEffect 2-arg form
 *
 * TODO (requires runtime validation with SolidStart v2):
 * - Verify ssrSource/deferStream + sharedConfig.hydrating cache sync
 * - isPending() / latest() integration for stale-while-revalidate UX
 * - Solid v2 action() bridge for useMutation optimistic updates
 */
import { hydrate, notifyManager, shouldThrowError } from '@tanstack/query-core'
import { isServer } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onCleanup,
  reconcile,
  sharedConfig,
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
// reconcileFn — kept from v1 (structural sharing for store updates)
// ------------------------------------------------------------
function reconcileFn<TData, TError>(
  store: QueryObserverResult<TData, TError>,
  result: QueryObserverResult<TData, TError>,
  reconcileOption:
    | string
    | false
    | ((oldData: TData | undefined, newData: TData) => TData),
  queryHash?: string,
): QueryObserverResult<TData, TError> {
  if (reconcileOption === false) return result
  if (typeof reconcileOption === 'function') {
    const newData = reconcileOption(store.data, result.data as TData)
    return { ...result, data: newData } as typeof result
  }
  let data = result.data
  if (store.data === undefined) {
    try {
      data = structuredClone(data)
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        if (error instanceof Error) {
          console.warn(
            `Unable to correctly reconcile data for query key: ${queryHash}. ` +
              `Possibly because the query data contains data structures that aren't supported ` +
              `by the 'structuredClone' algorithm. Consider using a callback function instead ` +
              `to manage the reconciliation manually.\n\n Error Received: ${error.name} - ${error.message}`,
          )
        }
      }
    }
  }
  const newData = reconcile(data, reconcileOption)(store.data)
  return { ...result, data: newData } as typeof result
}

// ------------------------------------------------------------
// useBaseQuery — Solid v2 PoC
//
// SSR: Solid v2's first-class async handles serialization across
// server→client boundary internally. We pass ssrSource/deferStream
// to createMemo and Solid v2 runtime handles:
//   - Server: run computation → serialize result via ctx.serialize()
//   - Client: restore value via sharedConfig.load() → subFetch for refetch
// No external <HydrationBoundary> wrapper needed (unlike React/Svelte).
//
// query-core cache sync: on hydration, we detect the restored data and
// call hydrate() to sync cache metadata (dataUpdatedAt, staleTime, etc.)
// that Solid v2 doesn't know about.
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

  let observerResult = observer().getOptimisticResult(defaultedOptions())
  const [state, setState] =
    createStore<QueryObserverResult<TData, TError>>(observerResult)

  function setStateWithReconciliation(res: typeof observerResult) {
    const opts = observer().options
    // @ts-expect-error - Reconcile option is not correctly typed internally
    const reconcileOptions = opts.reconcile

    setState((store) => {
      return reconcileFn(
        store,
        res,
        reconcileOptions === undefined ? false : reconcileOptions,
        opts.queryHash,
      )
    })
  }

  // -- SSR cache sync ---------------------------------------------------
  // Solid v2 restores the memo value automatically during hydration.
  // But query-core's cache needs metadata (dataUpdatedAt, status, etc.)
  // that only exists in the observer/query state.
  // We detect hydration and sync the cache so staleTime/gcTime work correctly.

  if (
    !isServer &&
    sharedConfig.hydrating &&
    observerResult.data !== undefined
  ) {
    const query = observer().getCurrentQuery()
    hydrate(client(), {
      queries: [
        {
          queryKey: query.queryKey,
          queryHash: query.queryHash,
          state: query.state,
          ...(query.meta && { meta: query.meta }),
        },
      ],
    })
  }

  // -- Subscription ----------------------------------------------------
  // v1 had separate createServerSubscriber / createClientSubscriber with
  // resolver + unsubscribeQueued for race conditions around createResource.
  // v2: single subscriber, no Promise wrapper needed.

  let unsubscribe: (() => void) | null = null

  function subscribe() {
    unsubscribe?.()
    const obs = observer()
    unsubscribe = obs.subscribe((result) => {
      notifyManager.batchCalls(() => {
        observerResult = result
        setStateWithReconciliation(result)
      })()
    })
  }

  if (!isRestoring()) {
    subscribe()
  }

  onCleanup(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  // -- Reactive option / client tracking --------------------------------
  // Solid v2: createComputed + on() removed. Using createEffect(compute, apply).

  // When QueryClient instance changes → new observer
  let prevClient = client()
  createEffect(
    () => client(),
    (c) => {
      if (c !== prevClient) {
        prevClient = c
        const newObserver = new Observer(c, defaultedOptions())
        setObserver(newObserver)
        subscribe()
      }
    },
  )

  // When options change → update observer + result
  let prevOpts = defaultedOptions()
  createEffect(
    () => [observer(), defaultedOptions()] as const,
    ([obs, opts]) => {
      if (opts !== prevOpts) {
        prevOpts = opts
        obs.setOptions(opts)
        observerResult = obs.getOptimisticResult(opts)
        setStateWithReconciliation(observerResult)
      }
    },
  )

  // When restoring finishes → subscribe + sync result
  let prevRestoring = isRestoring()
  createEffect(
    () => isRestoring(),
    (restoring) => {
      if (prevRestoring && !restoring && !isServer) {
        prevRestoring = restoring
        subscribe()
        observerResult = observer().getOptimisticResult(defaultedOptions())
        setStateWithReconciliation(observerResult)
      }
      prevRestoring = restoring
    },
  )

  // -- Suspension via Solid v2 native async ----------------------------
  //
  // How it works:
  //
  //   query-core's QueryObserver maintains a `#currentThenable` (a real
  //   Promise created via `new Promise()`). When data arrives or errors,
  //   the thenable is resolved/rejected via `.resolve()` / `.reject()`.
  //
  //   Solid v2's reactive runtime checks `result instanceof Promise` in
  //   processResult(). When a createMemo returns a pending Promise:
  //     1. Runtime creates a NotReadyError(promise)
  //     2. NotReadyError propagates through the reactive graph
  //     3. <Loading> boundary catches it and shows fallback
  //     4. When promise resolves → memo re-evaluates → <Loading> shows children
  //
  //   This replaces the entire createResource + createDeepSignal + Proxy hack
  //   from v1, which existed solely because Solid v1's only suspension
  //   mechanism was createResource.
  //
  // When to suspend:
  //   - Initial load (isPending + isFetching): return pending thenable
  //   - Background refetch (data exists + isFetching): return stale data (no suspend)
  //   - Error with throwOnError: throw the error
  //
  // For "refreshing" UI during background refetches, users can use
  // Solid v2's `isPending(() => query.data)` instead of checking `isFetching`.

  // ssrSource/deferStream passed to createMemo — Solid v2 runtime handles:
  //   Server: runs computation → serializes Promise result via ctx.serialize()
  //   Client: restores serialized value → schedules refetch via subFetch()
  const ssrMemoOptions = {
    ssrSource: options().ssrSource,
    deferStream: options().deferStream,
  }

  const data = createMemo(() => {
    // Error boundary support
    if (
      state.isError &&
      !state.isFetching &&
      !isRestoring() &&
      shouldThrowError(observer().options.throwOnError, [
        state.error,
        observer().getCurrentQuery(),
      ])
    ) {
      throw state.error
    }

    // Initial load → return the observer's pending thenable to trigger <Loading>
    if (state.isPending && state.isFetching && !isRestoring()) {
      // observerResult.promise is query-core's PendingThenable<TData>
      // which extends Promise<TData> (created via `new Promise()`)
      // → passes Solid v2's `instanceof Promise` check
      // → triggers NotReadyError → caught by <Loading> boundary
      return observerResult.promise
    }

    // Data available (or background refetch with stale data) → return synchronously
    return state.data
  }, ssrMemoOptions)

  // -- Return value -----------------------------------------------------
  // Proxy routes `data` access through the suspension-aware memo.
  // All other properties (isPending, isFetching, isError, error, etc.)
  // read directly from the reactive store — no suspension.
  //
  // v1 Proxy had to route through queryResource for createResource integration.
  // v2 Proxy just routes through createMemo — same pattern, much less machinery.

  const handler = {
    get(
      target: QueryObserverResult<TData, TError>,
      prop: keyof QueryObserverResult<TData, TError>,
    ): any {
      if (prop === 'data') {
        return data()
      }
      return Reflect.get(target, prop)
    },
  }

  return new Proxy(state, handler)
}
