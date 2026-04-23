import React, { Children, forwardRef, useImperativeHandle, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

type Props = {
  initialPage?: number;
  onPageSelected?: (e: { nativeEvent: { position: number } }) => void;
  offscreenPageLimit?: number;
  style?: ViewStyle;
  children?: React.ReactNode;
};

export type PagerHostHandle = {
  setPage: (page: number) => void;
};

const PagerHost = forwardRef<PagerHostHandle, Props>((props, ref) => {
  const [idx, setIdx] = useState(props.initialPage ?? 0);

  useImperativeHandle(
    ref,
    () => ({
      setPage: (page: number) => {
        setIdx(page);
        props.onPageSelected?.({ nativeEvent: { position: page } });
      },
    }),
    [props],
  );

  const kids = Children.toArray(props.children);
  const activeChild = kids[idx] ?? null;

  return <View style={[{ flex: 1 }, props.style]}>{activeChild}</View>;
});

PagerHost.displayName = 'PagerHost';

export default PagerHost;
