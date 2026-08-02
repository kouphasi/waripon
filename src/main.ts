import { mountAppFromUrl } from './app'
import './styles.css'

const root = document.querySelector<HTMLDivElement>('#app')

if (!root) {
  throw new Error('アプリケーションの表示先が見つかりません。')
}

void mountAppFromUrl(root)
