import { OperatorPage, type OperatorPageProps } from './Operator.js';

export type ConfigurationPageProps = OperatorPageProps;

export function ConfigurationPage(props: ConfigurationPageProps): JSX.Element {
  return <OperatorPage {...props} />;
}
