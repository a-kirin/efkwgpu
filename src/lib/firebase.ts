import type firebase from 'firebase/compat/app'

type FirebaseCompat = typeof firebase

declare global {
  interface Window {
    firebase?: FirebaseCompat
  }
}

const firebaseConfig = {
  apiKey: 'AIzaSyBluwFdBZePWtVkjyttbSKtA9y3K3m-Dxs',
  authDomain: 'kirin-art.firebaseapp.com',
  projectId: 'kirin-art',
  storageBucket: 'kirin-art.firebasestorage.app',
  messagingSenderId: '630238228990',
  appId: '1:630238228990:web:e340f6363d9a4eb6ed50af',
  measurementId: 'G-4H5BT05LT6',
}

const firebaseCompat = window.firebase

if (!firebaseCompat) {
  throw new Error('Firebase SDK not loaded. Check the CDN scripts in index.html.')
}

export const firebaseApp =
  firebaseCompat.apps.length > 0
    ? firebaseCompat.app()
    : firebaseCompat.initializeApp(firebaseConfig)

export const firebaseAuth = firebaseApp.auth()
export const firebaseDb = firebaseApp.firestore()
export const firebaseAnalytics = null

void firebaseAuth.setPersistence(firebaseCompat.auth.Auth.Persistence.LOCAL).catch(() => {
  // Keep default auth persistence if the browser blocks the preferred mode.
})

export default firebaseCompat
