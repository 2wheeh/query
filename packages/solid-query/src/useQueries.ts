/**
 * Solid v2 PoC — useQueries
 *
 * Same architectural changes as useBaseQuery:
 * - Removed createResource + dataResources + Proxy hack for suspension
 * - Removed taskQueue batching workaround
 * - Simplified subscription to direct store updates
 *
 * The v1 approach created a createResource per query result to trigger
 * Suspense on each query's data. In v2, suspension is handled at the
 * consumer level via <Loading> boundaries reading from async-aware memos.
 *
 * NOTE: useQueries in v1 already did NOT support Suspense well
 * (the data property was "a plain object and not a SolidJS Resource").
 * In v2, this could be revisited with native async support.
 */
import { QueriesObserver, noop } from '@tanstack/query-core'
// Solid v2: store exports moved to 'solid-js', mergeProps → merge
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  merge,
  onCleanup,
  snapshot,
} from 'solid-js'
import { useQueryClient } from './QueryClientProvider'
import { useIsRestoring } from './isRestoring'
import type { SolidQueryOptions, UseQueryResult } from './types'
import type { Accessor } from 'solid-js'
import type { QueryClient } from './QueryClient'
import type {
  DefaultError,
  OmitKeyof,
  QueriesObserverOptions,
  QueriesPlaceholderDataFunction,
  QueryFunction,
  QueryKey,
  QueryObserverOptions,
  ThrowOnError,
} from '@tanstack/query-core'

// This defines the `UseQueryOptions` that are accepted in `QueriesOptions` & `GetOptions`.
// `placeholderData` function does not have a parameter
type UseQueryOptionsForUseQueries<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> = OmitKeyof<
  SolidQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  'placeholderData'
> & {
  placeholderData?: TQueryFnData | QueriesPlaceholderDataFunction<TQueryFnData>
}

// Avoid TS depth-limit error in case of large array literal
type MAXIMUM_DEPTH = 20

// Widen the type of the symbol to enable type inference even if skipToken is not immutable.
type SkipTokenForUseQueries = symbol

type GetOptions<T> =
  // Part 1: responsible for applying explicit type parameter to function arguments, if object { queryFnData: TQueryFnData, error: TError, data: TData }
  T extends {
    queryFnData: infer TQueryFnData
    error?: infer TError
    data: infer TData
  }
    ? UseQueryOptionsForUseQueries<TQueryFnData, TError, TData>
    : T extends { queryFnData: infer TQueryFnData; error?: infer TError }
      ? UseQueryOptionsForUseQueries<TQueryFnData, TError>
      : T extends { data: infer TData; error?: infer TError }
        ? UseQueryOptionsForUseQueries<unknown, TError, TData>
        : // Part 2: responsible for applying explicit type parameter to function arguments, if tuple [TQueryFnData, TError, TData]
          T extends [infer TQueryFnData, infer TError, infer TData]
          ? UseQueryOptionsForUseQueries<TQueryFnData, TError, TData>
          : T extends [infer TQueryFnData, infer TError]
            ? UseQueryOptionsForUseQueries<TQueryFnData, TError>
            : T extends [infer TQueryFnData]
              ? UseQueryOptionsForUseQueries<TQueryFnData>
              : // Part 3: responsible for inferring and enforcing type if no explicit parameter was provided
                T extends {
                    queryFn?:
                      | QueryFunction<infer TQueryFnData, infer TQueryKey>
                      | SkipTokenForUseQueries
                    select?: (data: any) => infer TData
                    throwOnError?: ThrowOnError<any, infer TError, any, any>
                  }
                ? UseQueryOptionsForUseQueries<
                    TQueryFnData,
                    unknown extends TError ? DefaultError : TError,
                    unknown extends TData ? TQueryFnData : TData,
                    TQueryKey
                  >
                : // Fallback
                  UseQueryOptionsForUseQueries

type GetResults<T> =
  // Part 1: responsible for mapping explicit type parameter to function result, if object
  T extends { queryFnData: any; error?: infer TError; data: infer TData }
    ? UseQueryResult<TData, TError>
    : T extends { queryFnData: infer TQueryFnData; error?: infer TError }
      ? UseQueryResult<TQueryFnData, TError>
      : T extends { data: infer TData; error?: infer TError }
        ? UseQueryResult<TData, TError>
        : // Part 2: responsible for mapping explicit type parameter to function result, if tuple
          T extends [any, infer TError, infer TData]
          ? UseQueryResult<TData, TError>
          : T extends [infer TQueryFnData, infer TError]
            ? UseQueryResult<TQueryFnData, TError>
            : T extends [infer TQueryFnData]
              ? UseQueryResult<TQueryFnData>
              : // Part 3: responsible for mapping inferred type to results, if no explicit parameter was provided
                T extends {
                    queryFn?:
                      | QueryFunction<infer TQueryFnData, any>
                      | SkipTokenForUseQueries
                    select?: (data: any) => infer TData
                    throwOnError?: ThrowOnError<any, infer TError, any, any>
                  }
                ? UseQueryResult<
                    unknown extends TData ? TQueryFnData : TData,
                    unknown extends TError ? DefaultError : TError
                  >
                : // Fallback
                  UseQueryResult

/**
 * QueriesOptions reducer recursively unwraps function arguments to infer/enforce type param
 */
type QueriesOptions<
  T extends Array<any>,
  TResult extends Array<any> = [],
  TDepth extends ReadonlyArray<number> = [],
> = TDepth['length'] extends MAXIMUM_DEPTH
  ? Array<UseQueryOptionsForUseQueries>
  : T extends []
    ? []
    : T extends [infer Head]
      ? [...TResult, GetOptions<Head>]
      : T extends [infer Head, ...infer Tail]
        ? QueriesOptions<
            [...Tail],
            [...TResult, GetOptions<Head>],
            [...TDepth, 1]
          >
        : ReadonlyArray<unknown> extends T
          ? T
          : // If T is *some* array but we couldn't assign unknown[] to it, then it must hold some known/homogenous type!
            // use this to infer the param types in the case of Array.map() argument
            T extends Array<
                UseQueryOptionsForUseQueries<
                  infer TQueryFnData,
                  infer TError,
                  infer TData,
                  infer TQueryKey
                >
              >
            ? Array<
                UseQueryOptionsForUseQueries<
                  TQueryFnData,
                  TError,
                  TData,
                  TQueryKey
                >
              >
            : // Fallback
              Array<UseQueryOptionsForUseQueries>

/**
 * QueriesResults reducer recursively maps type param to results
 */
type QueriesResults<
  T extends Array<any>,
  TResult extends Array<any> = [],
  TDepth extends ReadonlyArray<number> = [],
> = TDepth['length'] extends MAXIMUM_DEPTH
  ? Array<UseQueryResult>
  : T extends []
    ? []
    : T extends [infer Head]
      ? [...TResult, GetResults<Head>]
      : T extends [infer Head, ...infer Tail]
        ? QueriesResults<
            [...Tail],
            [...TResult, GetResults<Head>],
            [...TDepth, 1]
          >
        : { [K in keyof T]: GetResults<T[K]> }

export function useQueries<
  T extends Array<any>,
  TCombinedResult extends QueriesResults<T> = QueriesResults<T>,
>(
  queriesOptions: Accessor<{
    queries:
      | readonly [...QueriesOptions<T>]
      | readonly [...{ [K in keyof T]: GetOptions<T[K]> }]
    combine?: (result: QueriesResults<T>) => TCombinedResult
  }>,
  queryClient?: Accessor<QueryClient>,
): TCombinedResult {
  const client = createMemo(() => useQueryClient(queryClient?.()))
  const isRestoring = useIsRestoring()

  const defaultedQueries = createMemo(() =>
    queriesOptions().queries.map((options) =>
      merge(
        client().defaultQueryOptions(options as QueryObserverOptions),
        {
          get _optimisticResults() {
            return isRestoring() ? 'isRestoring' : 'optimistic'
          },
        },
      ),
    ),
  )

  // Wrap observer in a signal so it can be recreated when client changes
  // (parallels useBaseQuery's pattern).
  const [observer, setObserver] = createSignal(
    new QueriesObserver(
      client(),
      defaultedQueries(),
      queriesOptions().combine
        ? ({
            combine: queriesOptions().combine,
          } as QueriesObserverOptions<TCombinedResult>)
        : undefined,
    ),
  )

  const initialResult = observer().getOptimisticResult(
    defaultedQueries(),
    (queriesOptions() as QueriesObserverOptions<TCombinedResult>).combine,
  )[1]()

  const [state, setState] = createStore<TCombinedResult>(initialResult as any)

  // When client changes → recreate observer (same pattern as useBaseQuery)
  createEffect(
    () => client(),
    (c, prevC) => {
      if (c !== prevC) {
        const combineOpt = queriesOptions().combine
          ? ({
              combine: queriesOptions().combine,
            } as QueriesObserverOptions<TCombinedResult>)
          : undefined
        setObserver(new QueriesObserver(c, defaultedQueries(), combineOpt))
      }
    },
  )

  // Solid v2: createEffect(compute, apply) with prev parameter
  createEffect(
    () => queriesOptions().queries.length,
    (length, prevLength) => {
      if (length !== prevLength) {
        const nextResult = observer().getOptimisticResult(
          defaultedQueries(),
          (queriesOptions() as QueriesObserverOptions<TCombinedResult>)
            .combine,
        )[1]()
        setState(() => nextResult)
      }
    },
  )

  // v2: Direct store update from observer subscription.
  // v1 had createResource per query + taskQueue + Proxy — all removed.
  let unsubscribe: () => void = noop
  createEffect(
    () => [isRestoring(), observer()] as const,
    ([restoring, obs]) => {
      unsubscribe()
      if (restoring) {
        unsubscribe = noop
      } else {
        unsubscribe = obs.subscribe((result) => {
          for (let index = 0; index < result.length; index++) {
            // @ts-expect-error typescript pedantry regarding the possible range of index
            setState(index, () => snapshot(result[index]))
          }
        })
      }
    },
  )
  onCleanup(() => unsubscribe())

  createEffect(
    () => [defaultedQueries(), observer()] as const,
    ([dq, obs]) => {
      obs.setQueries(
        dq,
        queriesOptions().combine
          ? ({
              combine: queriesOptions().combine,
            } as QueriesObserverOptions<TCombinedResult>)
          : undefined,
      )
    },
  )

  // v2: No Proxy needed. Data is directly in the store.
  // useQueries never fully supported Suspense in v1 either.
  // In v2, consumers can wrap individual query data reads in <Loading>
  // boundaries if needed.
  return state
}
