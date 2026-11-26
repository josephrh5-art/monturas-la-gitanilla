// Service worker mínimo: permite instalar el panel como app. No guarda datos de pedidos.
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",()=>{});
