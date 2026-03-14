import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { useQueryClient } from './QueryClientProvider'
import type { MutationFilters } from '@tanstack/query-core'
import type { QueryClient } from './QueryClient'
import type { Accessor } from 'solid-js'

export function useIsMutating(
  filters?: Accessor<MutationFilters>,
  queryClient?: Accessor<QueryClient>,
): Accessor<number> {
  const client = createMemo(() => useQueryClient(queryClient?.()))
  const mutationCache = createMemo(() => client().getMutationCache())

  const [mutations, setMutations] = createSignal(
    client().isMutating(filters?.()),
  )

  // Re-subscribe when mutationCache changes (client change)
  createEffect(
    () => mutationCache(),
    (cache) => {
      const unsubscribe = cache.subscribe(() => {
        setMutations(client().isMutating(filters?.()))
      })
      onCleanup(unsubscribe)
    },
  )

  return mutations
}
