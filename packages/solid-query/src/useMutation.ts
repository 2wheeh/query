import { MutationObserver, noop, shouldThrowError } from '@tanstack/query-core'
// Solid v2: createStore moved from 'solid-js/store' → 'solid-js'
// Solid v2: createComputed/on removed → use createEffect(compute, apply)
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onCleanup,
} from 'solid-js'
import { useQueryClient } from './QueryClientProvider'
import type { DefaultError } from '@tanstack/query-core'
import type { QueryClient } from './QueryClient'
import type {
  UseMutateFunction,
  UseMutationOptions,
  UseMutationResult,
} from './types'
import type { Accessor } from 'solid-js'

export function useMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  queryClient?: Accessor<QueryClient>,
): UseMutationResult<TData, TError, TVariables, TOnMutateResult> {
  const client = createMemo(() => useQueryClient(queryClient?.()))

  // Wrap observer in signal so it can be recreated when client changes
  // (same pattern as useBaseQuery)
  const [observer, setObserver] = createSignal(
    new MutationObserver<TData, TError, TVariables, TOnMutateResult>(
      client(),
      options(),
    ),
  )

  const mutate: UseMutateFunction<
    TData,
    TError,
    TVariables,
    TOnMutateResult
  > = (variables, mutateOptions) => {
    observer().mutate(variables, mutateOptions).catch(noop)
  }

  const [state, setState] = createStore<
    UseMutationResult<TData, TError, TVariables, TOnMutateResult>
  >({
    ...observer().getCurrentResult(),
    mutate,
    mutateAsync: observer().getCurrentResult().mutate,
  })

  // When client changes → recreate observer (same pattern as useBaseQuery)
  createEffect(
    () => client(),
    (c, prevC) => {
      if (c !== prevC) {
        setObserver(
          new MutationObserver<TData, TError, TVariables, TOnMutateResult>(
            c,
            options(),
          ),
        )
      }
    },
  )

  // Solid v2: createEffect(compute, apply) replaces createComputed
  createEffect(
    () => options(),
    (opts) => {
      observer().setOptions(opts)
    },
  )

  // Error boundary support via createMemo (same pattern as useBaseQuery).
  // Throwing in createMemo naturally propagates to <Errored> boundaries,
  // whereas throwing in createEffect has undefined behavior in Solid v2.
  createMemo(() => {
    if (
      state.isError &&
      shouldThrowError(observer().options.throwOnError, [state.error])
    ) {
      throw state.error
    }
  })

  // Subscription wrapped in createEffect for Solid v2 RFC 01 compliance
  // (no top-level side effects).
  createEffect(
    () => observer(),
    (obs) => {
      const unsubscribe = obs.subscribe((result) => {
        setState(() => ({
          ...result,
          mutate,
          mutateAsync: result.mutate,
        }))
      })
      onCleanup(unsubscribe)
    },
  )

  return state
}
