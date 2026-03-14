import { createContext, useContext } from 'solid-js'
import type { Accessor } from 'solid-js'

const IsRestoringContext = createContext<Accessor<boolean>>(() => false)

export const useIsRestoring = () => useContext(IsRestoringContext)
// Solid v2: Context itself is the Provider (no .Provider property)
export const IsRestoringProvider = IsRestoringContext
