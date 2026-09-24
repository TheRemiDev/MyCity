// Registre partagé des services de l'interface (évite les imports circulaires entre modules d'UI).
export const app = {
  renderer: null,
  select: () => {},
  refreshMe: async () => {},
  requireAuth: () => false,
  openEditor: () => {},
  openBillboardEditor: () => {},
  openProfile: () => {},
  openAccount: () => {},
  openAuth: () => {},
  closePanel: () => {},
};
