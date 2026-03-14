/**
 * Solid v2 PoC — useBaseQuery (signal-based subscription)
 *
 * v2 API: solid-js/store → solid-js, solid-js/web → @solidjs/web,
 *         createComputed(on(...)) → createEffect(compute, apply)
 *
 * TODO: ssrSource/deferStream validation, isPending()/latest() integration,
 *       createProjection for fine-grained reactivity
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
    defaultOptions.experimental_prefetchInRender = true
    if (isServer) {
      defaultOptions.retry = false
      defaultOptions.throwOnError = true
    }
    return defaultOptions
  })

  // -- Observer lifecycle --------------------------------------------------

  const [observer, setObserver] = createSignal(
    new Observer(client(), defaultedOptions()),
  )

  let observerResult = observer().getOptimisticResult(defaultedOptions())

  // Signal (not store) — signal writes schedule new flush cycles so memos
  // in dirtyQueue see the update. Store writes from EFFECT_USER arrive
  // after memos recompute → key changes wouldn't propagate.
  const [result, setResult] =
    createSignal<QueryObserverResult<TData, TError>>(observerResult)

  // -- Subscription --------------------------------------------------------

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

  // Synchronous — must run before createMemo triggers <Loading> suspension.
  // Deferred effects don't run while suspended → deadlock without this.
  if (!untrack(isRestoring)) {
    doSubscribe(untrack(observer))
  }
  onCleanup(() => currentUnsubscribe?.())

  // Re-subscribe reactively (takes over after <Loading> resolves)
  createEffect(
    () => [isRestoring(), observer()] as const,
    ([restoring, obs], prev) => {
      if (restoring) {
        currentUnsubscribe?.()
        currentUnsubscribe = undefined
        return
      }
      doSubscribe(obs)
      if (prev?.[0] && !isServer) {
        const res = obs.getOptimisticResult(defaultedOptions())
        observerResult = res
        setResult(res)
      }
    },
  )

  // -- Option / client tracking --------------------------------------------

  createEffect(
    () => client(),
    (c, prevC) => {
      if (c !== prevC) {
        setObserver(new Observer(c, defaultedOptions()))
      }
    },
  )

  // setOptions → #notify → subscription fires synchronously inside batch()
  // → setResult → new flush → memo re-evaluates. No manual setResult needed.
  createEffect(
    () => [observer(), defaultedOptions()] as const,
    ([obs, opts], prev) => {
      if (opts !== prev?.[1]) {
        obs.setOptions(opts)
      }
    },
  )

  // -- Suspension ----------------------------------------------------------

  const ssrMemoOptions = {
    ssrSource: options().ssrSource,
    deferStream: options().deferStream,
  }

  // Initial-only: after first resolution, never return a promise again.
  // Avoids asyncWrite REACTIVE_DIRTY bail-out on key changes.
  let hasSuspended = false

  const data = createMemo(() => {
    const r = result()

    if (!hasSuspended && r.status === 'pending' && !isRestoring()) {
      return observerResult.promise
    }
    hasSuspended = true

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

  // -- Proxy ---------------------------------------------------------------

  const proxyTarget = {} as QueryObserverResult<TData, TError>

  return new Proxy(proxyTarget, {
    get(
      _target: QueryObserverResult<TData, TError>,
      prop: keyof QueryObserverResult<TData, TError>,
    ): any {
      if (prop === 'data') return data()
      const r = result()
      const value = r[prop]
      return typeof value === 'function' ? value.bind(r) : value
    },
  })
}
