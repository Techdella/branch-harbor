import type { PartialDict } from './types';
/** Español — core strings. Missing keys fall back to English. */
const es: PartialDict = {
  common: { continue: 'Continuar', cancel: 'Cancelar', confirm: 'Confirmar', close: 'Cerrar', back: 'Atrás', retry: 'Reintentar', save: 'Guardar', send: 'Enviar', done: 'Listo', loading: 'Cargando…', unavailable: 'No disponible', notConnected: 'No conectado', today: 'Hoy', tomorrow: 'Mañana', approve: 'Aprobar', reject: 'Rechazar', approved: 'Aprobado', rejected: 'Rechazado', pending: 'Pendiente', refresh: 'Actualizar', lastUpdated: 'Actualizado %{time}', timesIn: 'Horas en %{zone}', errorTitle: 'Algo salió mal', offlineTitle: 'Sin conexión', offlineBody: 'Mostrando datos de %{time}. Pueden estar desactualizados; las acciones esperarán a que vuelvas a conectarte.', sampleData: 'Datos de ejemplo' },
  welcome: { tagline: 'Un hogar para cada sede.', signIn: 'Iniciar sesión', email: 'Correo electrónico', password: 'Contraseña', guest: 'Continuar como invitado', chooseExperience: 'Elige una experiencia', customer: 'Cliente', staff: 'Personal', owner: 'Propietario / Central' },
  tabs: { home: 'Inicio', book: 'Reservar', order: 'Pedir', bookings: 'Reservas', inbox: 'Mensajes', profile: 'Perfil', today: 'Hoy', checkin: 'Asistencia', kitchen: 'Cocina', messages: 'Mensajes', cover: 'Suplencias', pulse: 'Pulso', approvals: 'Aprobaciones', locations: 'Sedes', alerts: 'Alertas' },
  customer: { goodMorning: 'Buenos días', goodAfternoon: 'Buenas tardes', goodEvening: 'Buenas noches', chooseLocation: 'Elige una sede', nextClass: 'Próxima clase', offers: 'Ofertas' },
  book: { spotsLeft: { one: 'Queda 1 plaza', other: 'Quedan %{count} plazas' }, started: 'Comenzada', full: 'Completo · lista de espera abierta', bookCta: 'Reservar', waitlistCta: 'Lista de espera', booked: 'Reservado', policy: 'Política de cancelación', bookedDone: 'Reserva confirmada', waitlistDone: 'Estás en la lista de espera' },
  pay: { notConfigured: 'Pagos no configurados', processing: 'Procesando pago…', failed: 'El pago no se completó' },
  order: { title: 'Pedido para recoger', chooseTime: 'Elige una hora de recogida', soldOut: 'Agotado', add: 'Añadir', subtotal: 'Subtotal', tax: 'Impuestos', taxNote: 'Impuestos según la configuración del negocio', total: 'Total', awaitingTitle: 'Esperando que el restaurante acepte', readyTitle: 'Listo para recoger' },
  bookings: { title: 'Mis reservas', upcoming: 'Próximas', past: 'Pasadas', confirmed: 'Confirmada', cancelled: 'Cancelada', cancel: 'Cancelar reserva' },
  inbox: { title: 'Mensajes', you: 'Tú' },
  profile: { title: 'Perfil', language: 'Idioma', notifications: 'Notificaciones', push: 'Notificaciones push', email: 'Correo', sms: 'SMS', privacy: 'Privacidad y mis datos', exportData: 'Solicitar una copia de mis datos', deleteData: 'Solicitar eliminación de la cuenta', signOut: 'Cerrar sesión' },
  staff: { present: 'Presente', absent: 'Ausente', accept: 'Aceptar', rejectOrder: 'Rechazar', markReady: 'Marcar listo', waitingServer: 'Esperando al servidor…' },
  owner: { pulseTitle: 'Pulso de la red', businessPulseTitle: 'Pulso del negocio', noLocationYet: 'Añade la dirección de tu negocio en la app de BranchHarbor para ver tu pulso.', approvalsTitle: 'Aprobaciones', refund: 'Reembolso', shiftSwap: 'Cambio de turno', locationsTitle: 'Sedes' },
};
export default es;
