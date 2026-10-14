import type { PartialDict } from './types';
/** Português (Brasil) — core strings. Missing keys fall back to English. */
const ptBR: PartialDict = {
  common: { continue: 'Continuar', cancel: 'Cancelar', confirm: 'Confirmar', close: 'Fechar', back: 'Voltar', retry: 'Tentar novamente', save: 'Salvar', send: 'Enviar', done: 'Concluído', loading: 'Carregando…', unavailable: 'Indisponível', notConnected: 'Não conectado', today: 'Hoje', tomorrow: 'Amanhã', approve: 'Aprovar', reject: 'Recusar', approved: 'Aprovado', rejected: 'Recusado', pending: 'Pendente', refresh: 'Atualizar', lastUpdated: 'Atualizado %{time}', timesIn: 'Horários em %{zone}', errorTitle: 'Algo deu errado', offlineTitle: 'Você está offline', offlineBody: 'Mostrando dados de %{time}. Podem estar desatualizados — as ações aguardarão a reconexão.', sampleData: 'Dados de exemplo' },
  welcome: { tagline: 'Um lar para cada unidade.', signIn: 'Entrar', email: 'E-mail', password: 'Senha', guest: 'Continuar como visitante', chooseExperience: 'Escolha uma experiência', customer: 'Cliente', staff: 'Equipe', owner: 'Proprietário / Matriz' },
  tabs: { home: 'Início', book: 'Reservar', order: 'Pedir', bookings: 'Reservas', inbox: 'Mensagens', profile: 'Perfil', today: 'Hoje', checkin: 'Check-in', kitchen: 'Cozinha', messages: 'Mensagens', cover: 'Substituição', pulse: 'Panorama', approvals: 'Aprovações', locations: 'Unidades', alerts: 'Alertas' },
  customer: { goodMorning: 'Bom dia', goodAfternoon: 'Boa tarde', goodEvening: 'Boa noite', chooseLocation: 'Escolha uma unidade', nextClass: 'Próxima aula', offers: 'Ofertas' },
  book: { spotsLeft: { one: '1 vaga restante', other: '%{count} vagas restantes' }, started: 'Iniciada', full: 'Lotada · lista de espera aberta', bookCta: 'Reservar', waitlistCta: 'Lista de espera', booked: 'Reservado', policy: 'Política de cancelamento', bookedDone: 'Reserva confirmada', waitlistDone: 'Você está na lista de espera' },
  pay: { notConfigured: 'Pagamentos não configurados', processing: 'Processando pagamento…', failed: 'O pagamento não foi concluído' },
  order: { title: 'Pedido para retirada', chooseTime: 'Escolha um horário de retirada', soldOut: 'Esgotado', add: 'Adicionar', subtotal: 'Subtotal', tax: 'Impostos', taxNote: 'Impostos conforme configurado pela empresa', total: 'Total', awaitingTitle: 'Aguardando o restaurante aceitar', readyTitle: 'Pronto para retirada' },
  bookings: { title: 'Minhas reservas', upcoming: 'Próximas', past: 'Anteriores', confirmed: 'Confirmada', cancelled: 'Cancelada', cancel: 'Cancelar reserva' },
  inbox: { title: 'Mensagens', you: 'Você' },
  profile: { title: 'Perfil', language: 'Idioma', notifications: 'Notificações', push: 'Notificações push', email: 'E-mail', sms: 'SMS', privacy: 'Privacidade e meus dados', exportData: 'Solicitar cópia dos meus dados', deleteData: 'Solicitar exclusão da conta', signOut: 'Sair' },
  staff: { present: 'Presente', absent: 'Ausente', accept: 'Aceitar', rejectOrder: 'Recusar', markReady: 'Marcar como pronto', waitingServer: 'Aguardando o servidor…' },
  owner: { pulseTitle: 'Panorama da rede', businessPulseTitle: 'Panorama do negócio', noLocationYet: 'Adicione o endereço do seu negócio no app BranchHarbor para ver seu panorama.', approvalsTitle: 'Aprovações', refund: 'Reembolso', shiftSwap: 'Troca de turno', locationsTitle: 'Unidades' },
};
export default ptBR;
