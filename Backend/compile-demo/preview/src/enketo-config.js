// Copy of the CHT webapp's enketo config (cht-core webapp/src/js/enketo/config.js, cht-core 5.3.0).
// excludeNonRelevant: true means non-relevant (hidden) values are treated as blank in calculations
// and dropped on save, as in CHT.
export default {
  maps: [
    {
      tiles: ["https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"],
      name: "streets",
      attribution: 'Map data © <a href="http://openstreetmap.org">OpenStreetMap</a> contributors',
    },
  ],
  repeatOrdinals: false,
  validateContinuously: false,
  validatePage: true,
  swipePage: false,
  textMaxChars: 2000,
  excludeNonRelevant: true,
  experimentalOptimizations: {
    computeAsync: false,
  },
};
