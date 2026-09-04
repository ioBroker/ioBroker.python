import { createRoot } from 'react-dom/client';

import App from './App';
import pkg from '../package.json';

// GenericApp reads this to know which adapter it belongs to.
(window as unknown as { adapterName: string }).adapterName = 'python';

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(<App version={pkg.version} />);
}
