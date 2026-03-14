import {
  createContext,
  createRenderEffect,
  useContext,
} from 'solid-js'
import type { QueryClient } from './QueryClient'
import type { JSX } from 'solid-js'

export const QueryClientContext = createContext<
  (() => QueryClient) | undefined
>(undefined)

export const useQueryClient = (queryClient?: QueryClient) => {
  if (queryClient) {
    return queryClient
  }
  const client = useContext(QueryClientContext)

  if (!client) {
    throw new Error('No QueryClient set, use QueryClientProvider to set one')
  }

  return client()
}

export type QueryClientProviderProps = {
  client: QueryClient
  children?: JSX.Element
}

export const QueryClientProvider = (
  props: QueryClientProviderProps,
): JSX.Element => {
  // Solid v2: createRenderEffect uses compute→apply pattern.
  // Cleanup is handled via return value (Solid v2 RFC 01) —
  // no separate onCleanup needed to avoid double unmount().
  createRenderEffect(
    () => props.client,
    (client) => {
      client.mount()
      return () => client.unmount()
    },
  )

  // Solid v2: Context itself is the Provider component (no .Provider)
  return (
    <QueryClientContext value={() => props.client}>
      {props.children}
    </QueryClientContext>
  )
}
