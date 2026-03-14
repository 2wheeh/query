import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { useQueryClient } from './QueryClientProvider'
import type { QueryFilters } from '@tanstack/query-core'
import type { QueryClient } from './QueryClient'
import type { Accessor } from 'solid-js'

export function useIsFetching(
  filters?: Accessor<QueryFilters>,
  queryClient?: Accessor<QueryClient>,
): Accessor<number> {
  const client = createMemo(() => useQueryClient(queryClient?.()))
  const queryCache = createMemo(() => client().getQueryCache())

  const [fetches, setFetches] = createSignal(client().isFetching(filters?.()))

  // Re-subscribe when queryCache changes (client change)
  createEffect(
    () => queryCache(),
    (cache) => {
      const unsubscribe = cache.subscribe(() => {
        setFetches(client().isFetching(filters?.()))
      })
      onCleanup(unsubscribe)
    },
  )

  return fetches
}
