import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { type ViewStyle } from 'react-native';
import PagerView from 'react-native-pager-view';

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
  const innerRef = useRef<PagerView>(null);

  useImperativeHandle(
    ref,
    () => ({
      setPage: (page: number) => {
        innerRef.current?.setPage(page);
      },
    }),
    [],
  );

  return (
    <PagerView
      ref={innerRef}
      style={props.style}
      initialPage={props.initialPage}
      onPageSelected={props.onPageSelected}
      offscreenPageLimit={props.offscreenPageLimit}
    >
      {props.children}
    </PagerView>
  );
});

PagerHost.displayName = 'PagerHost';

export default PagerHost;
