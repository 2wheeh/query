// Solid v2: createEffect split into compute → apply phases
// Solid v2: createComputed removed
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { replaceEqualDeep } from '@tanstack/query-core'
import { useQueryClient } from './QueryClientProvider'
import type {
  Mutation,
  MutationCache,
  MutationFilters,
  MutationState,
} from '@tanstack/query-core'
import type { Accessor } from 'solid-js'
import type { QueryClient } from './QueryClient'

type MutationStateOptions<TResult = MutationState> = {
  filters?: MutationFilters
  select?: (mutation: Mutation) => TResult
}

function getResult<TResult = MutationState>(
  mutationCache: MutationCache,
  options: MutationStateOptions<TResult>,
): Array<TResult> {
  return mutationCache
    .findAll(options.filters)
    .map(
      (mutation): TResult =>
        (options.select ? options.select(mutation) : mutation.state) as TResult,
    )
}

export function useMutationState<TResult = MutationState>(
  options: Accessor<MutationStateOptions<TResult>> = () => ({}),
  queryClient?: Accessor<QueryClient>,
): Accessor<Array<TResult>> {
  const client = createMemo(() => useQueryClient(queryClient?.()))
  const mutationCache = createMemo(() => client().getMutationCache())

  const [result, setResult] = createSignal(
    getResult(mutationCache(), options()),
  )

  // Solid v2: createEffect(compute, apply)
  createEffect(
    () => mutationCache(),
    (cache) => {
      const unsubscribe = cache.subscribe(() => {
        const nextResult = replaceEqualDeep(
          result(),
          getResult(cache, options()),
        )
        if (result() !== nextResult) {
          setResult(nextResult)
        }
      })

      onCleanup(unsubscribe)
    },
  )

  return result
}
