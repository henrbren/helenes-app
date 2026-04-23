module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Må være sist (Expo / react-native-reanimated)
      'react-native-reanimated/plugin',
    ],
  };
};
