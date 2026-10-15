import { useStore } from '@nanostores/react'

import { $backdrop } from '@/store/backdrop'

import { BackdropImage } from './ui/backdrop-image'

export function Backdrop() {
  const on = useStore($backdrop)

  if (!on) {
    return null
  }

  return <BackdropImage />
}
