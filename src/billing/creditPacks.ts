import type { CreditPackId } from '../lib/firestoreUsers'

export type CreditPackDefinition = {
  id: CreditPackId
  label: string
  credits: number
  priceUsd: number
  featured: boolean
}

export const CREDIT_PACKS: CreditPackDefinition[] = [
  {
    id: 'starter_10',
    label: 'Starter Pack',
    credits: 10,
    priceUsd: 4,
    featured: false,
  },
  {
    id: 'value_40',
    label: 'Value Pack',
    credits: 40,
    priceUsd: 12,
    featured: true,
  },
]
