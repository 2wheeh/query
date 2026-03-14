import { MutationObserver, noop, shouldThrowError } from '@tanstack/query-core'
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

  // Observer in signal — recreated when client changes
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

  // Client change → new observer
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

  // Options tracking
  createEffect(
    () => options(),
    (opts) => {
      observer().setOptions(opts)
    },
  )

  // Error boundary support via createMemo.
  // Throwing in createMemo propagates to <Errored> boundaries.
  createMemo(() => {
    if (
      state.isError &&
      shouldThrowError(observer().options.throwOnError, [state.error])
    ) {
      throw state.error
    }
  })

  // Subscription in createEffect — re-subscribes when observer changes
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
