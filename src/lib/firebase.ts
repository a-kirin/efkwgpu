import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics'

const firebaseConfig = {
  apiKey: 'AIzaSyBluwFdBZePWtVkjyttbSKtA9y3K3m-Dxs',
  authDomain: 'kirin-art.firebaseapp.com',
  projectId: 'kirin-art',
  storageBucket: 'kirin-art.firebasestorage.app',
  messagingSenderId: '630238228990',
  appId: '1:630238228990:web:e340f6363d9a4eb6ed50af',
  measurementId: 'G-4H5BT05LT6',
}

export const firebaseApp = initializeApp(firebaseConfig)
export let firebaseAnalytics: Analytics | null = null

void isSupported()
  .then((supported) => {
    if (supported) {
      firebaseAnalytics = getAnalytics(firebaseApp)
    }
  })
  .catch(() => {
    firebaseAnalytics = null
  })
